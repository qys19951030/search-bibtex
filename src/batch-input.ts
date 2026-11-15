/**
 * batch-input.ts — Batch input resolution for directory and manifest inputs.
 *
 * A batch run accepts either:
 * - a directory, whose immediate `*.pdf` files are processed in filename order; or
 * - a manifest file containing one path per line, where blank lines and lines
 *   starting with `#` are ignored.
 *
 * Duplicate paths inside a single run are processed only once, while the number
 * of repeated occurrences is reported separately so the final summary remains
 * faithful to the raw input.
 *
 * @module batch-input
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

/**
 * A resolved batch input: the unique paths to process plus the number of
 * duplicate occurrences that were collapsed away.
 */
export interface BatchInputResolution {
  /** Unique input paths in processing order. */
  paths: string[];
  /** Number of repeated path occurrences that appeared after the first one. */
  duplicateCount: number;
}

/**
 * Resolve a directory path into its immediate PDF files, sorted by filename.
 *
 * Only files ending in `.pdf` (case-insensitive) directly inside the directory
 * are considered; subdirectories are not traversed.
 *
 * @param directory - Path to a directory containing PDF files.
 * @returns Ordered, de-duplicated absolute PDF paths.
 */
export async function resolveDirectoryInputs(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && /\.pdf$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right))
    .map((name) => path.resolve(directory, name));
}

/**
 * Parse manifest text into ordered, trimmed, non-empty paths.
 *
 * Blank lines and lines whose first non-whitespace character is `#` are
 * ignored. Inline comments are not supported: a `#` only starts a comment when
 * it begins the (trimmed) line.
 *
 * @param text - The raw manifest file contents.
 * @returns The ordered list of paths as written in the manifest.
 */
export function parseManifestText(text: string): string[] {
  const paths: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    paths.push(line);
  }
  return paths;
}

/**
 * Read a manifest file from disk and parse it into ordered paths.
 *
 * @param manifestPath - Path to the manifest file.
 * @param baseDir - Directory used to resolve relative paths. Defaults to the
 *   manifest file's own directory.
 * @returns The ordered list of resolved (absolute when relative) paths.
 */
export async function resolveManifestInputs(
  manifestPath: string,
  baseDir: string = path.dirname(path.resolve(manifestPath))
): Promise<string[]> {
  const text = await readFile(manifestPath, "utf8");
  return parseManifestText(text).map((entry) => path.resolve(baseDir, entry));
}

/**
 * Collapse an ordered list of paths so each path appears only once.
 *
 * Path comparison is performed on the raw resolved string (callers are
 * expected to resolve relative paths first). The first occurrence determines
 * processing order; every later occurrence increments the duplicate counter.
 *
 * @param paths - Ordered paths, possibly containing repeats.
 * @returns The unique paths in first-seen order and the collapsed duplicate count.
 */
export function deduplicatePaths(paths: string[]): BatchInputResolution {
  const seen = new Set<string>();
  const unique: string[] = [];
  let duplicateCount = 0;

  for (const entry of paths) {
    if (seen.has(entry)) {
      duplicateCount += 1;
      continue;
    }
    seen.add(entry);
    unique.push(entry);
  }

  return { paths: unique, duplicateCount };
}
