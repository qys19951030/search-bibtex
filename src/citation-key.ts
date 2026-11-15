/**
 * citation-key.ts — Deterministic BibTeX citation-key generation, collision
 * handling, and pre-flight output validation.
 *
 * Keys are derived from a fixed rule on the record's first author surname,
 * publication year, and first title word. When several records produce the same
 * base key inside one .bib file, predictable numeric suffixes (`-1`, `-2`, ...)
 * distinguish them so an existing entry is never overwritten.
 *
 * The module also centralizes the three failures that must be raised *before*
 * any network search starts: an unwritable target .bib, a result path that is
 * not a directory, and an existing .bib whose contents cannot be parsed.
 *
 * @module citation-key
 */

import { constants as fsConstants } from "node:fs";
import { access, mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { parseBibtexDocument } from "./bibtex-file.js";
import type { BibtexRecord } from "./bibtex.js";
import type { SearchResult } from "./types.js";

/**
 * Error raised during batch pre-flight validation, before any search begins.
 */
export class BatchPreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BatchPreflightError";
  }
}

/**
 * Build the base citation key for a record from author, year and title.
 *
 * Rule: first author's last whitespace-separated token (fallback `paper`),
 * then the 4-digit year (`nd` when absent), then the first alphanumeric title
 * word (fallback `work`); every character outside `[A-Za-z0-9:_-]` is removed.
 *
 * @param record - The bibliographic record carrying authors, year and title.
 * @returns The deterministic, collision-free base key.
 */
export function buildCitationKey(record: Pick<BibtexRecord, "authors" | "year" | "title">): string {
  const firstAuthor = record.authors[0]?.split(/\s+/).at(-1) ?? "paper";
  const firstTitleWord = record.title.match(/[A-Za-z0-9]+/)?.[0] ?? "work";
  const year = record.year ? String(record.year) : "nd";
  return `${firstAuthor}${year}${firstTitleWord}`.replace(/[^A-Za-z0-9:_-]/g, "");
}

/**
 * Allocates unique citation keys across an existing .bib file and all newly
 * assigned records. Collisions get deterministic `-1`, `-2`, ... suffixes.
 */
export class CitationKeyAllocator {
  private readonly claimed = new Set<string>();

  private constructor(existingKeys: Iterable<string>) {
    for (const key of existingKeys) {
      this.claimed.add(key);
    }
  }

  /**
   * Create an allocator seeded with every citation key already present in a
   * parsed BibTeX document.
   */
  static fromBibtexText(bibtexText: string): CitationKeyAllocator {
    const keys: string[] = [];
    for (const segment of parseBibtexDocument(bibtexText)) {
      if (segment.kind === "entry" && segment.entry?.citationKey) {
        keys.push(segment.entry.citationKey.trim());
      }
    }
    return new CitationKeyAllocator(keys);
  }

  /** Create an empty allocator for outputs that do not pre-exist. */
  static empty(): CitationKeyAllocator {
    return new CitationKeyAllocator([]);
  }

  /**
   * Reserve a unique key for one result. The base key follows
   * {@link buildCitationKey}; on collision the first free `-N` suffix wins.
   *
   * @param record - The result or record needing a citation key.
   * @returns The allocated, collision-free citation key.
   */
  allocate(record: Pick<BibtexRecord, "authors" | "year" | "title">): string {
    const base = buildCitationKey(record);
    if (!this.claimed.has(base)) {
      this.claimed.add(base);
      return base;
    }
    let suffix = 1;
    let candidate = `${base}-${suffix}`;
    while (this.claimed.has(candidate)) {
      suffix += 1;
      candidate = `${base}-${suffix}`;
    }
    this.claimed.add(candidate);
    return candidate;
  }
}

/**
 * Rewrite the citation key inside a raw BibTeX entry string.
 *
 * @param bibtex - A single raw BibTeX entry.
 * @param citationKey - The key to write into the entry header.
 * @returns The entry text with its key replaced.
 */
export function rewriteBibtexEntryKey(bibtex: string, citationKey: string): string {
  const normalized = bibtex.trim();
  const updated = normalized.replace(
    /^(@[A-Za-z][A-Za-z0-9_-]*\s*[\{\(]\s*)([^,]+)(\s*,)/s,
    (_match, prefix: string, _existingKey: string, suffix: string) => `${prefix}${citationKey}${suffix}`
  );

  if (updated === normalized) {
    throw new Error(`Unable to rewrite BibTeX citation key for ${citationKey}.`);
  }
  return updated;
}

/**
 * Validate that a BibTeX entry carries a recognizable header and key.
 *
 * @param bibtex - A single raw BibTeX entry.
 * @returns `true` when the header parses and a key is present.
 */
export function hasParsableBibtexHeader(bibtex: string): boolean {
  return /^@[A-Za-z][A-Za-z0-9_-]*\s*[\{\(]\s*[^,\s][^,]*\s*,/s.test(bibtex.trim());
}

/**
 * Run all batch output pre-flight checks before any source is queried.
 *
 * Guarantees:
 * - the target .bib file is writable (existing file writable; otherwise its
 *   parent directory exists and is writable, creating the file is allowed);
 * - the journal/result directory is an existing directory;
 * - an existing .bib parses completely, with no dangling entry or keyless entry.
 *
 * @param bibPath - Destination BibTeX file path.
 * @param resultDir - Directory that will hold the append-only result journal.
 * @returns The current contents of the .bib file (empty string when absent)
 *   and an allocator seeded with its existing keys.
 */
export async function validateBatchOutputs(
  bibPath: string,
  resultDir: string
): Promise<{ existingBibtex: string; allocator: CitationKeyAllocator }> {
  const resolvedBib = path.resolve(bibPath);
  const resolvedResultDir = path.resolve(resultDir);

  await assertWritableBibTarget(resolvedBib);
  await assertDirectory(resolvedResultDir);

  let existingBibtex = "";
  try {
    existingBibtex = await readFile(resolvedBib, "utf8");
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }

  if (existingBibtex !== "") {
    assertBibtexFullyParsable(existingBibtex, resolvedBib);
  }

  return {
    existingBibtex,
    allocator: CitationKeyAllocator.fromBibtexText(existingBibtex)
  };
}

async function assertWritableBibTarget(resolvedBib: string): Promise<void> {
  try {
    const info = await stat(resolvedBib);
    if (!info.isFile()) {
      throw new BatchPreflightError(`BibTeX target is not a file: ${resolvedBib}`);
    }
    await access(resolvedBib, fsConstants.W_OK);
    return;
  } catch (error) {
    if (isMissingFileError(error)) {
      const parent = path.dirname(resolvedBib);
      await assertDirectory(parent);
      await access(parent, fsConstants.W_OK);
      return;
    }
    if (error instanceof BatchPreflightError) {
      throw error;
    }
    throw new BatchPreflightError(
      `BibTeX target is not writable: ${resolvedBib} (${error instanceof Error ? error.message : String(error)})`
    );
  }
}

async function assertDirectory(resolvedDir: string): Promise<void> {
  try {
    const info = await stat(resolvedDir);
    if (!info.isDirectory()) {
      throw new BatchPreflightError(`Expected a directory but found another file type: ${resolvedDir}`);
    }
  } catch (error) {
    if (isMissingFileError(error)) {
      await mkdir(resolvedDir, { recursive: true });
      return;
    }
    throw error;
  }
}

function assertBibtexFullyParsable(text: string, bibPath: string): void {
  const segments = parseBibtexDocument(text);
  for (const segment of segments) {
    if (segment.kind !== "entry" || !segment.entry) {
      continue;
    }
    if (!segment.entry.parsed || !segment.entry.citationKey?.trim()) {
      throw new BatchPreflightError(`Existing BibTeX file contains an unparseable or keyless entry: ${bibPath}`);
    }
  }
  if (hasDanglingEntryText(text)) {
    throw new BatchPreflightError(`Existing BibTeX file contains an unclosed entry: ${bibPath}`);
  }
}

/**
 * Detect an `@type(` / `@type{` header whose entry body was never closed. The
 * parser keeps such a fragment as a trailing text segment, so it is checked
 * directly against the raw document.
 */
function hasDanglingEntryText(text: string): boolean {
  const headerPattern = /@[A-Za-z][A-Za-z0-9_-]*\s*[\{\(]/g;
  for (const match of text.matchAll(headerPattern)) {
    const openIndex = match.index + match[0].length - 1;
    const openChar = text[openIndex];
    const closeChar = openChar === "{" ? "}" : ")";
    let depth = 1;
    let inQuote = false;
    let escaped = false;

    for (let index = openIndex + 1; index < text.length; index += 1) {
      const char = text[index];
      if (inQuote) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (char === "\\") {
          escaped = true;
          continue;
        }
        if (char === '"') {
          inQuote = false;
        }
        continue;
      }
      if (char === '"') {
        inQuote = true;
        continue;
      }
      if (char === openChar) {
        depth += 1;
      } else if (char === closeChar) {
        depth -= 1;
        if (depth === 0) {
          break;
        }
      }
      if (index === text.length - 1 && depth > 0) {
        return true;
      }
    }

    if (depth > 0) {
      return true;
    }
  }
  return false;
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
