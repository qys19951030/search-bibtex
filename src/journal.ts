/**
 * journal.ts — Append-only, crash-safe result journal for batch runs.
 *
 * Every processed input appends exactly one JSON record as a single line
 * (newline-delimited JSON). Writes go through an append-mode write stream in
 * small chunks and are flushed per record, so an interruption at any moment
 * leaves all previously written lines complete and parseable. Reads stream the
 * file line by line instead of loading it whole; a final partial line (the
 * interrupted write) is tolerated and counted, never fatal.
 *
 * The journal is the source of truth for incremental re-runs: previously hit
 * inputs are skipped, while misses and failures are retried.
 *
 * @module journal
 */

import { createReadStream, createWriteStream, type WriteStream } from "node:fs";
import { access, constants as fsConstants, readFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

import type { PaperSource } from "./types.js";

/** Terminal status recorded for each processed input. */
export type JournalEntryStatus = "hit" | "miss" | "failed" | "skipped";

/**
 * One journal line describing the outcome of a single input.
 */
export interface JournalEntry {
  /** Resolved input path. */
  path: string;
  status: JournalEntryStatus;
  /** Strong identifiers of the chosen paper when a hit was recorded. */
  identifiers?: {
    doi?: string;
    arxivId?: string;
  };
  /** Citation key written into the .bib file when a hit was recorded. */
  citationKey?: string;
  /** Sources that contributed to the merged record when a hit was recorded. */
  contributingSources?: PaperSource[];
  /** Failure message when the input errored. */
  error?: string;
  /** Wall-clock milliseconds spent processing the input. */
  elapsedMs: number;
  /** Epoch milliseconds at which the record was appended. */
  recordedAt: number;
}

/**
 * Snapshot of an existing journal used to plan a re-run.
 */
export interface JournalState {
  /** Latest entry written for each input path. */
  entriesByPath: Map<string, JournalEntry>;
  /** Entries in file order, including every historical line. */
  entries: JournalEntry[];
  /** Full lines that could not be parsed (a torn final write counts as one). */
  corruptLineCount: number;
}

/** Default journal file name inside the result directory. */
export const DEFAULT_JOURNAL_FILE = "batch-results.jsonl";

/**
 * Resolve the journal path inside a result directory.
 */
export function resolveJournalPath(resultDir: string, fileName: string = DEFAULT_JOURNAL_FILE): string {
  return path.join(path.resolve(resultDir), fileName);
}

/**
 * Append-only writer for newline-delimited journal records.
 *
 * Each {@link AppendOnlyJournal.append} serializes one record, writes it as a
 * single chunk terminated by `\n`, and waits for the stream to drain/acknowledge
 * before returning, guaranteeing durable, line-atomic output on normal exits.
 */
export class AppendOnlyJournal {
  private readonly stream: WriteStream;
  private pending: Promise<void> = Promise.resolve();

  private constructor(stream: WriteStream) {
    this.stream = stream;
  }

  /**
   * Open the journal in append mode, creating it when absent.
   *
   * @param filePath - Absolute path to the JSONL journal.
   */
  static open(filePath: string): AppendOnlyJournal {
    const stream = createWriteStream(filePath, { flags: "a" });
    stream.on("error", (error) => {
      stream.destroy();
      throw error;
    });
    return new AppendOnlyJournal(stream);
  }

  /**
   * Append one record as a complete JSON line and wait for it to be flushed.
   */
  append(entry: JournalEntry): Promise<void> {
    const line = `${JSON.stringify(entry)}\n`;
    this.pending = this.pending.then(
      () =>
        new Promise<void>((resolve, reject) => {
          this.stream.write(line, (error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        })
    );
    return this.pending;
  }

  /** Flush queued writes and close the underlying stream. */
  async close(): Promise<void> {
    await this.pending;
    await new Promise<void>((resolve, reject) => {
      this.stream.end((error: Error | undefined) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}

/**
 * Read and index a journal, streaming it line by line.
 *
 * A missing file yields an empty state. A line that fails to parse — including
 * a torn final line left by a hard interruption — increments
 * {@link JournalState.corruptLineCount} and is skipped instead of throwing.
 *
 * @param filePath - Absolute path to the JSONL journal.
 * @returns The indexed journal state.
 */
export async function readJournal(filePath: string): Promise<JournalState> {
  try {
    await access(filePath, fsConstants.R_OK);
  } catch (error) {
    if (isMissingFileError(error)) {
      return { entriesByPath: new Map(), entries: [], corruptLineCount: 0 };
    }
    throw error;
  }

  const entries: JournalEntry[] = [];
  const entriesByPath = new Map<string, JournalEntry>();
  let corruptLineCount = 0;

  const stream = createReadStream(filePath, { encoding: "utf8" });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of lines) {
    if (line.trim() === "") {
      continue;
    }
    const parsed = parseJournalLine(line);
    if (!parsed) {
      corruptLineCount += 1;
      continue;
    }
    entries.push(parsed);
    entriesByPath.set(parsed.path, parsed);
  }

  return { entriesByPath, entries, corruptLineCount };
}

/**
 * Read the full journal contents as text. Used only for tests and small-file
 * assertions; batch processing itself always goes through {@link readJournal}.
 */
export async function readJournalText(filePath: string): Promise<string> {
  return await readFile(filePath, "utf8");
}

/**
 * Determine whether a previously journaled input should be skipped on re-run.
 * Only successful hits are skipped; misses and failures are retried.
 */
export function isTerminalHit(entry: JournalEntry | undefined): entry is JournalEntry {
  return entry?.status === "hit";
}

function parseJournalLine(line: string): JournalEntry | undefined {
  try {
    const value: unknown = JSON.parse(line);
    if (!isJournalEntry(value)) {
      return undefined;
    }
    return value;
  } catch {
    return undefined;
  }
}

function isJournalEntry(value: unknown): value is JournalEntry {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.path === "string" &&
    typeof record.status === "string" &&
    ["hit", "miss", "failed", "skipped"].includes(record.status) &&
    typeof record.elapsedMs === "number" &&
    typeof record.recordedAt === "number"
  );
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
