import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runBatch, type BatchInputProcessor, type ProcessedBatchInput } from "../src/batch.js";
import { BatchPreflightError } from "../src/citation-key.js";
import { readJournal, readJournalText, resolveJournalPath } from "../src/journal.js";
import type { MergedBibliographicCandidate } from "../src/merge.js";
import type { PdfMetadataCandidate } from "../src/types.js";

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "search-bibtex-batch-"));
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

function mergedRecord(overrides: Partial<MergedBibliographicCandidate> = {}): MergedBibliographicCandidate {
  return {
    source: "dblp",
    title: "Example Paper Title",
    authors: ["Jane Doe"],
    year: 2024,
    matchedQuery: "doi",
    score: 0.91,
    scoreBreakdown: { title: 1, author: 1, year: 1, identifier: 1, source: 1 },
    contributingSources: ["dblp"],
    fieldSources: { title: "dblp" },
    mergedCandidateCount: 1,
    firstRankedIndex: 0,
    bibtex: "@inproceedings{ignoredKey,\n  title = {Example Paper Title}\n}",
    ...overrides
  };
}

function processorFor(statusByPath: Record<string, ProcessedBatchInput["status"]>): BatchInputProcessor {
  return async (filePath) => {
    const status = statusByPath[filePath] ?? "miss";
    const metadata: PdfMetadataCandidate = {
      filePath,
      pageCount: 1,
      title: "Example Paper Title",
      authors: ["Jane Doe"],
      year: 2024,
      textSample: ""
    };
    if (status === "failed") {
      return { status, metadata, merged: [], sourceErrors: [], error: "simulated failure", elapsedMs: 5 };
    }
    if (status === "miss") {
      return { status, metadata, merged: [], sourceErrors: [], elapsedMs: 5 };
    }
    return { status, metadata, merged: [mergedRecord()], sourceErrors: [], elapsedMs: 7 };
  };
}

const budget = { perSourceConcurrency: 2, perSourceBudgetMs: 60_000, failureThreshold: 3 };

describe("batch orchestration", () => {
  it("records hit/miss/failed statuses, appends one bib entry per hit, and keeps JSON and .bib in one-to-one correspondence", async () => {
    const bibPath = path.join(tempRoot, "out.bib");
    const resultDir = path.join(tempRoot, "results");
    await mkdir(resultDir);
    const paths = [
      path.join(tempRoot, "hit.pdf"),
      path.join(tempRoot, "miss.pdf"),
      path.join(tempRoot, "failed.pdf")
    ];

    const result = await runBatch({
      inputs: { paths, duplicateCount: 1 },
      bibPath,
      resultDir,
      budget,
      processInput: processorFor({
        [paths[0]]: "hit",
        [paths[1]]: "miss",
        [paths[2]]: "failed"
      }),
      now: () => 1_700_000_000_000
    });

    expect(result.summary).toMatchObject({
      totalInputs: 3,
      duplicateCount: 1,
      hits: 1,
      misses: 1,
      failures: 1,
      skipped: 0
    });
    expect(result.bibtexEntriesWritten).toBe(1);
    expect(result.records.filter((record) => record.status === "hit")).toHaveLength(1);

    const bibText = await readFile(bibPath, "utf8");
    const entryCount = (bibText.match(/@[A-Za-z]+\{/g) ?? []).length;
    expect(entryCount).toBe(result.bibtexEntriesWritten);
    expect(bibText).toContain("@inproceedings{Doe2024Example,");

    const journal = await readJournal(resolveJournalPath(resultDir));
    expect(journal.entries).toHaveLength(3);
    expect(journal.entries.map((entry) => entry.status)).toEqual(["hit", "miss", "failed"]);
    expect(journal.entries[0].citationKey).toBe("Doe2024Example");
  });

  it("skips previously hit inputs on re-run while retrying misses and failures, counting skips separately", async () => {
    const bibPath = path.join(tempRoot, "out.bib");
    const resultDir = path.join(tempRoot, "results");
    await mkdir(resultDir);
    const paths = [
      path.join(tempRoot, "hit.pdf"),
      path.join(tempRoot, "retry-miss.pdf"),
      path.join(tempRoot, "retry-failed.pdf")
    ];
    const options = {
      inputs: { paths, duplicateCount: 0 },
      bibPath,
      resultDir,
      budget
    };

    const first = await runBatch({
      ...options,
      processInput: processorFor({
        [paths[0]]: "hit",
        [paths[1]]: "miss",
        [paths[2]]: "failed"
      })
    });
    expect(first.summary.skipped).toBe(0);

    const second = await runBatch({
      ...options,
      processInput: processorFor({
        [paths[1]]: "hit",
        [paths[2]]: "hit"
      })
    });

    expect(second.summary).toMatchObject({ skipped: 1, hits: 2, misses: 0, failures: 0 });
    const bibText = await readFile(bibPath, "utf8");
    expect((bibText.match(/@[A-Za-z]+\{/g) ?? []).length).toBe(3);
    expect(second.records.find((record) => record.path === paths[0])?.status).toBe("skipped");

    // Skipped inputs are themselves journaled, so the journal records every
    // processed input and stays a complete, re-playable history.
    const journal = await readJournal(resolveJournalPath(resultDir));
    const skipEntries = journal.entries.filter((entry) => entry.status === "skipped");
    expect(skipEntries).toHaveLength(1);
    expect(skipEntries[0].path).toBe(paths[0]);
    expect(skipEntries[0].citationKey).toBe(first.records[0].citationKey);
  });

  it("distinguishes colliding citation keys with suffixes instead of overwriting", async () => {
    const bibPath = path.join(tempRoot, "out.bib");
    const resultDir = path.join(tempRoot, "results");
    await mkdir(resultDir);
    const paths = [path.join(tempRoot, "a.pdf"), path.join(tempRoot, "b.pdf")];

    const result = await runBatch({
      inputs: { paths, duplicateCount: 0 },
      bibPath,
      resultDir,
      budget,
      processInput: async (filePath) => ({
        status: "hit",
        metadata: { filePath, pageCount: 1, title: "Same Title", authors: ["Jane Doe"], year: 2024, textSample: "" },
        merged: [mergedRecord({ title: "Same Title" })],
        sourceErrors: [],
        elapsedMs: 1
      })
    });

    const keys = result.records.map((record) => record.citationKey);
    expect(keys).toEqual(["Doe2024Same", "Doe2024Same-1"]);
    const bibText = await readFile(bibPath, "utf8");
    expect(bibText).toContain("Doe2024Same,");
    expect(bibText).toContain("Doe2024Same-1,");
  });

  it("tolerates a torn final journal line and counts it", async () => {
    const resultDir = path.join(tempRoot, "results");
    await mkdir(resultDir);
    const journalPath = resolveJournalPath(resultDir);
    const validLine = JSON.stringify({
      path: path.join(tempRoot, "old.pdf"),
      status: "hit",
      citationKey: "Doe2024Old",
      elapsedMs: 1,
      recordedAt: 1
    });
    await writeFile(journalPath, `${validLine}\n{"path":"torn","sta`);

    const state = await readJournal(journalPath);
    expect(state.entries).toHaveLength(1);
    expect(state.corruptLineCount).toBe(1);
    expect(state.entriesByPath.get(path.join(tempRoot, "old.pdf"))?.status).toBe("hit");

    const text = await readJournalText(journalPath);
    expect(text.endsWith("{\"path\":\"torn\",\"sta")).toBe(true);
  });

  it("fails preflight before searching when the bib target is not writable", async () => {
    // A target whose parent path is an existing file cannot be created or
    // written; this is reliable even under root, where chmod read-only does not
    // block writes.
    const blockingFile = path.join(tempRoot, "blocker");
    await writeFile(blockingFile, "i occupy the parent slot");
    const bibPath = path.join(blockingFile, "out.bib");
    const resultDir = path.join(tempRoot, "results");
    await mkdir(resultDir);

    await expect(runBatch({
      inputs: { paths: [path.join(tempRoot, "a.pdf")], duplicateCount: 0 },
      bibPath,
      resultDir,
      budget,
      processInput: processorFor({})
    })).rejects.toBeInstanceOf(BatchPreflightError);
  });

  it("fails preflight when the result path is not a directory", async () => {
    const bibPath = path.join(tempRoot, "out.bib");
    const resultDir = path.join(tempRoot, "not-a-dir");
    await writeFile(resultDir, "i am a file");

    await expect(runBatch({
      inputs: { paths: [path.join(tempRoot, "a.pdf")], duplicateCount: 0 },
      bibPath,
      resultDir,
      budget,
      processInput: processorFor({})
    })).rejects.toBeInstanceOf(BatchPreflightError);
  });

  it("fails preflight when an existing bib cannot be fully parsed", async () => {
    const bibPath = path.join(tempRoot, "broken.bib");
    await writeFile(bibPath, "@article{unterminated, title = {Missing closing brace");
    const resultDir = path.join(tempRoot, "results");
    await mkdir(resultDir);

    await expect(runBatch({
      inputs: { paths: [path.join(tempRoot, "a.pdf")], duplicateCount: 0 },
      bibPath,
      resultDir,
      budget,
      processInput: processorFor({})
    })).rejects.toBeInstanceOf(BatchPreflightError);
  });
});

