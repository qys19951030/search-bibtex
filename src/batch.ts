/**
 * batch.ts — Batch orchestration for many PDF inputs.
 *
 * Ties the building blocks together:
 * 1. pre-flight output validation (unwritable .bib, non-directory result dir,
 *    unparsable existing .bib fail before any network request);
 * 2. reading the append-only journal to plan an incremental re-run;
 * 3. per-input metadata extraction, budgeted multi-source search, cross-source
 *    candidate merging, BibTeX resolution, deterministic citation-key
 *    allocation, and chunked appends to the .bib file and journal;
 * 4. a summary whose BibTeX entries and JSON records correspond one-to-one.
 *
 * Inputs are processed sequentially in the supplied order so BibTeX key
 * assignment, journal ordering and summary records are fully deterministic;
 * per-source concurrency inside each input is still bounded by the budget
 * registry, and a slow/failing source degrades to "absent" rather than failing
 * the whole file.
 *
 * @module batch
 */

import { appendFile } from "node:fs/promises";

import { formatBibtexText } from "./bibtex.js";
import { type BatchInputResolution } from "./batch-input.js";
import {
  CitationKeyAllocator,
  hasParsableBibtexHeader,
  rewriteBibtexEntryKey,
  validateBatchOutputs
} from "./citation-key.js";
import { mergeBibliographicCandidates, type MergedBibliographicCandidate } from "./merge.js";
import {
  AppendOnlyJournal,
  isTerminalHit,
  readJournal,
  resolveJournalPath,
  type JournalEntry,
  type JournalEntryStatus
} from "./journal.js";
import { buildMetadataCandidate } from "./metadata.js";
import { extractPdfDocumentSnapshot } from "./pdf.js";
import { rankBibliographicCandidates, type RankedBibliographicCandidate } from "./ranking.js";
import {
  createSearchSourceRegistry,
  fetchBibtexForRankedCandidates,
  mergeSearchPreferences,
  searchSourceCandidates,
  type BibliographySearchOptions
} from "./search.js";
import { createBudgetedRegistry, type SourceBudgetController, type SourceBudgetOptions, type SourceBudgetStats } from "./source-budget.js";
import type {
  PaperSource,
  PdfMetadataCandidate,
  SearchPreferences,
  SearchSourceError
} from "./types.js";

/** Status of one batch input, mirroring the journal vocabulary. */
export type BatchInputStatus = JournalEntryStatus;

/**
 * A single input's outcome as reported in the JSON summary. Hit records also
 * carry the merged paper's identifiers, provenance and assigned citation key.
 */
export interface BatchInputRecord {
  path: string;
  status: BatchInputStatus;
  identifiers?: {
    doi?: string;
    arxivId?: string;
  };
  citationKey?: string;
  score?: number;
  contributingSources?: PaperSource[];
  fieldSources?: MergedBibliographicCandidate["fieldSources"];
  mergedCandidateCount?: number;
  error?: string;
  elapsedMs: number;
}

/** Per-source counters and average latency for the whole batch. */
export interface BatchSourceSummary {
  source: PaperSource;
  successCount: number;
  failureCount: number;
  skippedCount: number;
  averageElapsedMs: number;
  circuitOpen: boolean;
  budgetExhausted: boolean;
}

/**
 * Top-level batch summary. Counts follow these identities:
 * - `totalInputs === unique input paths`;
 * - `totalInputs + duplicateCount === raw input line count`;
 * - `hits + misses + failures + skipped === totalInputs`;
 * - `hits === BibTeX entries written during this run === records with
 *   status "hit" in {@link BatchRunResult.records}`.
 */
export interface BatchSummary {
  totalInputs: number;
  duplicateCount: number;
  hits: number;
  misses: number;
  failures: number;
  skipped: number;
  mergedDuplicateCount: number;
  corruptJournalLines: number;
  sources: BatchSourceSummary[];
}

/** Everything produced by a batch run. */
export interface BatchRunResult {
  summary: BatchSummary;
  records: BatchInputRecord[];
  bibtexEntriesWritten: number;
  journalPath: string;
  bibPath: string;
}

/** Options for {@link runBatch}. */
export interface BatchRunOptions {
  /** Resolved, ordered unique input paths plus the collapsed duplicate count. */
  inputs: BatchInputResolution;
  /** Destination .bib file (created when absent, appended to otherwise). */
  bibPath: string;
  /** Directory holding the append-only result journal. */
  resultDir: string;
  /** Injected search options (fetcher, preferences, timeout, parallel). */
  searchOptions?: BibliographySearchOptions;
  /** Per-source budget settings. */
  budget: SourceBudgetOptions;
  /** Override the journal file name (mainly for tests). */
  journalFileName?: string;
  /** Injected input processor; defaults to the real PDF + search pipeline. */
  processInput?: BatchInputProcessor;
  /** Clock injection for deterministic tests. */
  now?: () => number;
}

/**
 * A fully processed input before it is persisted. The orchestrator supplies
 * citation-key allocation and journaling; implementations supply the search.
 */
export interface ProcessedBatchInput {
  status: Exclude<BatchInputStatus, "skipped">;
  metadata: PdfMetadataCandidate;
  merged: MergedBibliographicCandidate[];
  /** Raw source errors encountered for this input. */
  sourceErrors: SearchSourceError[];
  error?: string;
  elapsedMs: number;
}

/** Injectable per-input pipeline so tests can avoid PDFs and the network. */
export type BatchInputProcessor = (
  filePath: string,
  context: BatchProcessorContext
) => Promise<ProcessedBatchInput>;

/**
 * Options for {@link createDefaultBatchInputProcessor}. A metadata override
 * lets callers (and offline tests) skip PDF extraction while still running the
 * genuine search, rank, merge and BibTeX stages.
 */
export interface DefaultProcessorOptions {
  /** Replace PDF extraction with pre-built metadata for the given path. */
  metadataFor?: (filePath: string) => PdfMetadataCandidate | undefined;
}

/**
 * Build the standard per-input processor. Extracts PDF metadata by default, or
 * uses {@link DefaultProcessorOptions.metadataFor} when supplied.
 */
export function createDefaultBatchInputProcessor(
  options: DefaultProcessorOptions = {}
): BatchInputProcessor {
  return async (filePath, context) => {
    const startedAt = Date.now();
    const metadata = options.metadataFor?.(filePath) ??
      buildMetadataCandidate(await extractPdfDocumentSnapshot(filePath));

    return await runSearchMergePipeline(metadata, context, startedAt);
  };
}

/**
 * Default per-input pipeline: extract PDF metadata, run budgeted source
 * searches, rank, merge same-paper candidates, and fetch BibTeX for the best.
 */
export const defaultBatchInputProcessor: BatchInputProcessor = createDefaultBatchInputProcessor();

/**
 * Shared search -> rank -> merge -> BibTeX pipeline used by the default
 * processor. Exposed so alternative extraction front-ends reuse it unchanged.
 */
export async function runSearchMergePipeline(
  metadata: PdfMetadataCandidate,
  context: BatchProcessorContext,
  startedAt: number = Date.now()
): Promise<ProcessedBatchInput> {
  const stage = await searchSourceCandidates(metadata, {
    fetcher: context.fetcher,
    preferences: context.preferences,
    sourceRegistry: context.sourceRegistry,
    parallel: context.parallel,
    timeoutMs: context.timeoutMs
  });

  const ranked = rankBibliographicCandidates(metadata, stage.candidates, context.preferences);
  const { records: merged } = mergeBibliographicCandidates(ranked);
  const top = merged.slice(0, context.preferences.limit);

  const { results, sourceErrors: bibtexErrors } = await fetchBibtexForRankedCandidates(top, {
    sourceRegistry: context.sourceRegistry,
    fetcher: context.fetcher,
    timeoutMs: context.timeoutMs,
    limit: context.preferences.limit
  });

  const status: ProcessedBatchInput["status"] = results.length > 0 ? "hit" : "miss";
  const mergedWithBibtex = attachBibtexToMerged(top, results);

  return {
    status,
    metadata,
    merged: mergedWithBibtex,
    sourceErrors: [...stage.sourceErrors, ...bibtexErrors],
    elapsedMs: Date.now() - startedAt
  };
}

/** Services handed to an input processor. */
export interface BatchProcessorContext {
  sourceRegistry: ReturnType<typeof createBudgetedRegistry>["registry"];
  preferences: SearchPreferences;
  fetcher: NonNullable<BibliographySearchOptions["fetcher"]>;
  timeoutMs: number;
  parallel: boolean;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Accumulated BibTeX chunk size (bytes) that triggers an incremental flush to
 * the destination .bib file. Entries smaller than this are still flushed at
 * the end of the run.
 */
const BIB_FLUSH_CHUNK_BYTES = 64 * 1024;

/**
 * Execute a full batch run.
 *
 * @throws {@link BatchPreflightError} (via validation) before searching when
 *   outputs are unusable or the existing .bib cannot be parsed.
 */
export async function runBatch(options: BatchRunOptions): Promise<BatchRunResult> {
  const journalPath = resolveJournalPath(options.resultDir, options.journalFileName);
  const { existingBibtex, allocator } = await validateBatchOutputs(options.bibPath, options.resultDir);
  const journalState = await readJournal(journalPath);

  const baseRegistry = options.searchOptions?.sourceRegistry ??
    createSearchSourceRegistry(options.searchOptions?.customSources);
  const { registry, controller } = createBudgetedRegistry(baseRegistry, options.budget);
  const preferences = mergeSearchPreferences(options.searchOptions?.preferences);
  const fetcher = options.searchOptions?.fetcher ?? fetch;
  const timeoutMs = options.searchOptions?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const parallel = options.searchOptions?.parallel ?? true;
  const now = options.now ?? (() => Date.now());

  const processor = options.processInput ?? defaultBatchInputProcessor;
  const context: BatchProcessorContext = { sourceRegistry: registry, preferences, fetcher, timeoutMs, parallel };
  const journal = AppendOnlyJournal.open(journalPath);

  const records: BatchInputRecord[] = [];
  let bibtexEntriesWritten = 0;
  let hits = 0;
  let misses = 0;
  let failures = 0;
  let skipped = 0;
  let mergedDuplicateCount = 0;
  let bibBuffer = "";
  let pendingBibChunk = "";

  /**
   * Append one BibTeX entry to the in-memory chunk and flush once the chunk
   * reaches {@link BIB_FLUSH_CHUNK_BYTES}, so large runs never hold the whole
   * output file in memory. The journal entry is always written first (inside
   * {@link persistProcessedInput}), guaranteeing the journal is ahead of the
   * .bib even if a flush is interrupted.
   */
  const appendBibChunk = async (chunk: string): Promise<void> => {
    bibBuffer += chunk;
    if (bibBuffer.length >= BIB_FLUSH_CHUNK_BYTES) {
      await appendFile(options.bibPath, bibBuffer, "utf8");
      bibBuffer = "";
    }
  };

  try {
    for (const filePath of options.inputs.paths) {
      const previous = journalState.entriesByPath.get(filePath);
      if (isTerminalHit(previous)) {
        skipped += 1;
        await journal.append({
          path: filePath,
          status: "skipped",
          identifiers: previous.identifiers,
          citationKey: previous.citationKey,
          elapsedMs: 0,
          recordedAt: now()
        });
        records.push({
          path: filePath,
          status: "skipped",
          citationKey: previous.citationKey,
          identifiers: previous.identifiers,
          elapsedMs: 0
        });
        continue;
      }

      const startedAt = now();
      let processed: ProcessedBatchInput;
      try {
        processed = await processor(filePath, context);
      } catch (error) {
        processed = {
          status: "failed",
          metadata: buildFailedMetadata(filePath),
          merged: [],
          sourceErrors: [],
          error: error instanceof Error ? error.message : String(error),
          elapsedMs: now() - startedAt
        };
      }

      mergedDuplicateCount += processed.merged.reduce(
        (total, record) => total + Math.max(0, record.mergedCandidateCount - 1),
        0
      );

      const record = await persistProcessedInput(processed, {
        filePath,
        allocator,
        journal,
        now,
        appendBib: (chunk) => {
          pendingBibChunk = chunk;
        }
      });
      if (pendingBibChunk !== "") {
        await appendBibChunk(pendingBibChunk);
        pendingBibChunk = "";
      }
      records.push(record);

      if (record.status === "hit") {
        hits += 1;
        bibtexEntriesWritten += 1;
      } else if (record.status === "miss") {
        misses += 1;
      } else {
        failures += 1;
      }
    }

    if (bibBuffer !== "") {
      await appendFile(options.bibPath, bibBuffer, "utf8");
    }
  } finally {
    await journal.close();
  }

  const summary = buildSummary({
    inputs: options.inputs,
    hits,
    misses,
    failures,
    skipped,
    mergedDuplicateCount,
    corruptJournalLines: journalState.corruptLineCount,
    controller
  });

  return {
    summary,
    records,
    bibtexEntriesWritten,
    journalPath,
    bibPath: options.bibPath
  };
}

interface PersistContext {
  filePath: string;
  allocator: CitationKeyAllocator;
  journal: AppendOnlyJournal;
  now: () => number;
  appendBib: (chunk: string) => void;
}

async function persistProcessedInput(
  processed: ProcessedBatchInput,
  context: PersistContext
): Promise<BatchInputRecord> {
  const base: Omit<BatchInputRecord, "status"> = {
    path: context.filePath,
    elapsedMs: processed.elapsedMs
  };

  if (processed.status === "failed") {
    const entry: JournalEntry = {
      path: context.filePath,
      status: "failed",
      error: processed.error,
      elapsedMs: processed.elapsedMs,
      recordedAt: context.now()
    };
    await context.journal.append(entry);
    return { ...base, status: "failed", error: processed.error };
  }

  const best = processed.merged.find((record) => Boolean(record.bibtex));
  if (processed.status === "miss" || !best || !best.bibtex) {
    await context.journal.append({
      path: context.filePath,
      status: "miss",
      elapsedMs: processed.elapsedMs,
      recordedAt: context.now()
    });
    return { ...base, status: "miss" };
  }

  if (!hasParsableBibtexHeader(best.bibtex)) {
    const error = "Selected result returned an unparsable BibTeX entry.";
    await context.journal.append({
      path: context.filePath,
      status: "failed",
      error,
      elapsedMs: processed.elapsedMs,
      recordedAt: context.now()
    });
    return { ...base, status: "failed", error };
  }

  const citationKey = context.allocator.allocate(best);
  const rewritten = formatBibtexText(rewriteBibtexEntryKey(best.bibtex, citationKey));
  context.appendBib(`${rewritten}\n\n`);

  const identifiers = {
    doi: best.doi,
    arxivId: best.arxivId
  };

  await context.journal.append({
    path: context.filePath,
    status: "hit",
    identifiers,
    citationKey,
    contributingSources: best.contributingSources,
    elapsedMs: processed.elapsedMs,
    recordedAt: context.now()
  });

  return {
    ...base,
    status: "hit",
    identifiers,
    citationKey,
    score: best.score,
    contributingSources: best.contributingSources,
    fieldSources: best.fieldSources,
    mergedCandidateCount: best.mergedCandidateCount
  };
}

function attachBibtexToMerged(
  merged: MergedBibliographicCandidate[],
  results: Array<RankedBibliographicCandidate & { bibtex: string }>
): MergedBibliographicCandidate[] {
  return merged.map((record) => {
    const match = results.find((result) =>
      result.source === record.source &&
      result.title === record.title &&
      (result.sourceId ?? "") === (record.sourceId ?? "")
    );
    return match ? { ...record, bibtex: match.bibtex } : record;
  });
}

function buildSummary(params: {
  inputs: BatchInputResolution;
  hits: number;
  misses: number;
  failures: number;
  skipped: number;
  mergedDuplicateCount: number;
  corruptJournalLines: number;
  controller: SourceBudgetController;
}): BatchSummary {
  return {
    totalInputs: params.inputs.paths.length,
    duplicateCount: params.inputs.duplicateCount,
    hits: params.hits,
    misses: params.misses,
    failures: params.failures,
    skipped: params.skipped,
    mergedDuplicateCount: params.mergedDuplicateCount,
    corruptJournalLines: params.corruptJournalLines,
    sources: summarizeSourceStats(params.controller.stats())
  };
}

function summarizeSourceStats(stats: SourceBudgetStats[]): BatchSourceSummary[] {
  return stats.map((stat) => {
    const attempts = stat.successCount + stat.failureCount;
    return {
      source: stat.source,
      successCount: stat.successCount,
      failureCount: stat.failureCount,
      skippedCount: stat.skippedCount,
      averageElapsedMs: attempts > 0 ? Number((stat.totalElapsedMs / attempts).toFixed(3)) : 0,
      circuitOpen: stat.circuitOpen,
      budgetExhausted: stat.budgetExhausted
    };
  });
}

function buildFailedMetadata(filePath: string): PdfMetadataCandidate {
  return {
    filePath,
    pageCount: 0,
    authors: [],
    textSample: ""
  };
}
