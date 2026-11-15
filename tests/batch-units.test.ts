import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parseManifestText, deduplicatePaths, resolveDirectoryInputs } from "../src/batch-input.js";
import {
  WEAK_AUTHOR_THRESHOLD,
  WEAK_TITLE_THRESHOLD,
  candidatesDescribeSamePaper,
  mergeBibliographicCandidates
} from "../src/merge.js";
import { CitationKeyAllocator, buildCitationKey, hasParsableBibtexHeader, rewriteBibtexEntryKey } from "../src/citation-key.js";
import { SourceBudgetError, createBudgetedRegistry } from "../src/source-budget.js";
import { createSearchSourceRegistry } from "../src/search.js";
import type { RankedBibliographicCandidate } from "../src/ranking.js";

function ranked(overrides: Partial<RankedBibliographicCandidate>): RankedBibliographicCandidate {
  return {
    source: "dblp",
    title: "Self-Instruct Aligning Language Models",
    authors: ["Yizhong Wang", "Yeganeh Kordi"],
    year: 2023,
    matchedQuery: "title",
    score: 1,
    scoreBreakdown: { title: 1, author: 1, year: 1, identifier: 1, source: 1 },
    ...overrides
  };
}

describe("manifest parsing and de-duplication", () => {
  it("ignores blank lines and hash comments while preserving order", () => {
    const text = [
      "# full-line comment",
      "papers/a.pdf",
      "",
      "   ",
      "  # indented comment",
      "papers/b.pdf",
      "papers/c.pdf"
    ].join("\n");

    expect(parseManifestText(text)).toEqual([
      "papers/a.pdf",
      "papers/b.pdf",
      "papers/c.pdf"
    ]);
  });

  it("collapses repeated paths but counts the duplicates faithfully", () => {
    const resolution = deduplicatePaths(["a.pdf", "b.pdf", "a.pdf", "a.pdf", "b.pdf"]);

    expect(resolution.paths).toEqual(["a.pdf", "b.pdf"]);
    expect(resolution.duplicateCount).toBe(3);
  });

  it("resolves a directory to its immediate PDFs in filename order, ignoring subdirectories", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "batch-inputs-"));
    try {
      await writeFile(path.join(root, "zeta.pdf"), "x");
      await writeFile(path.join(root, "Alpha.PDF"), "x");
      await writeFile(path.join(root, "notes.txt"), "x");
      await mkdir(path.join(root, "subdir"));
      await writeFile(path.join(root, "subdir", "nested.pdf"), "x");

      const resolved = await resolveDirectoryInputs(root);
      expect(resolved.map((entry) => path.basename(entry))).toEqual(["Alpha.PDF", "zeta.pdf"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("citation key generation and collision handling", () => {
  it("builds keys from author surname, year and first title word", () => {
    expect(buildCitationKey({
      authors: ["Yizhong Wang", "Yeganeh Kordi"],
      year: 2023,
      title: "Self-Instruct: Aligning Language Models"
    })).toBe("Wang2023Self");

    expect(buildCitationKey({ authors: [], title: "Anonymous Work" })).toBe("paperndAnonymous");
  });

  it("distinguishes same-key records with numeric suffixes and never reuses a key", () => {
    const allocator = CitationKeyAllocator.fromBibtexText("@article{Wang2023Self, title = {x}}");
    const record = { authors: ["Yizhong Wang"], year: 2023, title: "Self-Instruct Paper" };

    expect(allocator.allocate(record)).toBe("Wang2023Self-1");
    expect(allocator.allocate(record)).toBe("Wang2023Self-2");
    expect(allocator.allocate({ authors: ["Other Person"], year: 2024, title: "Different" })).toBe(
      "Person2024Different"
    );
  });

  it("rewrites the key in a raw entry and detects unparsable headers", () => {
    const rewritten = rewriteBibtexEntryKey("@inproceedings{OldKey,\n  title = {T}\n}", "NewKey");
    expect(rewritten).toContain("@inproceedings{NewKey,");
    expect(hasParsableBibtexHeader("@inproceedings{NewKey,")).toBe(true);
    expect(hasParsableBibtexHeader("not an entry")).toBe(false);
  });
});

describe("cross-source candidate merging", () => {
  it("merges candidates sharing a DOI and records per-field provenance and sources", () => {
    const dblp = ranked({
      source: "dblp",
      sourceId: "conf/acl/WangK23",
      title: "Self-Instruct Aligning Language Models",
      authors: ["Yizhong Wang"],
      year: 2023,
      doi: "10.18653/v1/2023.acl-long.754",
      venue: "ACL",
      score: 0.95
    });
    const crossref = ranked({
      source: "crossref",
      sourceId: "10.18653/v1/2023.acl-long.754",
      title: "Self-Instruct: Aligning Language Models with Self-Generated Instructions",
      authors: ["Yizhong Wang", "Yeganeh Kordi"],
      year: 2023,
      doi: "10.18653/V1/2023.ACL-LONG.754",
      url: "https://doi.org/10.18653/v1/2023.acl-long.754",
      score: 0.8
    });

    const outcome = mergeBibliographicCandidates([dblp, crossref]);

    expect(outcome.records).toHaveLength(1);
    expect(outcome.mergedDuplicateCount).toBe(1);
    const merged = outcome.records[0];
    expect(merged.contributingSources).toEqual(["dblp", "crossref"]);
    expect(merged.mergedCandidateCount).toBe(2);
    expect(merged.score).toBe(0.95);
    expect(merged.fieldSources.authors).toBe("crossref");
    expect(merged.fieldSources.url).toBe("crossref");
    expect(merged.fieldSources.venue).toBe("dblp");
    expect(merged.authors).toEqual(["Yizhong Wang", "Yeganeh Kordi"]);
  });

  it("merges weak-identifier candidates only when title and authors are close and years agree", () => {
    const left = ranked({ source: "openalex", title: "Attention Is All You Need", authors: ["Ashish Vaswani", "Noam Shazeer"], year: 2017 });
    const close = ranked({ source: "semantic-scholar", title: "Attention is all you need!", authors: ["Ashish Vaswani", "Noam Shazeer"], year: 2017 });
    const conflictingYear = ranked({ source: "crossref", title: "Attention Is All You Need", authors: ["Ashish Vaswani"], year: 2018 });
    const unrelated = ranked({ source: "dblp", title: "Bert Pretraining of Deep Bidirectional Transformers", authors: ["Jacob Devlin"], year: 2019 });

    expect(candidatesDescribeSamePaper(left, close)).toBe(true);
    expect(candidatesDescribeSamePaper(left, conflictingYear)).toBe(false);
    expect(candidatesDescribeSamePaper(left, unrelated)).toBe(false);

    const outcome = mergeBibliographicCandidates([left, close, conflictingYear, unrelated]);
    expect(outcome.records).toHaveLength(3);
    expect(outcome.mergedDuplicateCount).toBe(1);
  });

  it("keeps weak thresholds within their documented bounds", () => {
    expect(WEAK_TITLE_THRESHOLD).toBeGreaterThan(0.8);
    expect(WEAK_AUTHOR_THRESHOLD).toBeGreaterThan(0.5);
  });

  it("preserves the pre-merge preference order when merged scores tie", () => {
    const first = ranked({ source: "dblp", title: "Paper Alpha", authors: ["A One"], year: 2020, score: 0.5 });
    const second = ranked({ source: "openalex", title: "Paper Beta", authors: ["B Two"], year: 2021, score: 0.5 });

    const outcome = mergeBibliographicCandidates([first, second]);
    expect(outcome.records.map((record) => record.title)).toEqual(["Paper Alpha", "Paper Beta"]);
  });
});

describe("source budget registry", () => {
  it("opens the circuit after consecutive failures and skips later calls", async () => {
    let attempts = 0;
    const base = createSearchSourceRegistry();
    base.set("flaky", {
      name: "flaky",
      search: async () => {
        attempts += 1;
        throw new Error("boom");
      }
    });

    const { registry } = createBudgetedRegistry(base, {
      perSourceConcurrency: 1,
      perSourceBudgetMs: 60_000,
      failureThreshold: 2
    });
    const source = registry.get("flaky");
    if (!source) {
      throw new Error("flaky source missing");
    }

    await expect(source.search(makeContext())).rejects.toThrow("boom");
    await expect(source.search(makeContext())).rejects.toThrow("boom");
    await expect(source.search(makeContext())).rejects.toBeInstanceOf(SourceBudgetError);
    expect(attempts).toBe(2);
  });

  it("caps concurrent calls to a single source with a semaphore", async () => {
    let active = 0;
    let maxActive = 0;
    const base = createSearchSourceRegistry();
    base.set("slow", {
      name: "slow",
      search: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
        return [];
      }
    });

    const { registry } = createBudgetedRegistry(base, {
      perSourceConcurrency: 2,
      perSourceBudgetMs: 60_000,
      failureThreshold: 3
    });
    const source = registry.get("slow");
    if (!source) {
      throw new Error("slow source missing");
    }

    await Promise.all([source.search(makeContext()), source.search(makeContext()), source.search(makeContext()), source.search(makeContext())]);
    expect(maxActive).toBeLessThanOrEqual(2);
    expect(maxActive).toBe(2);
  });

  function makeContext() {
    return {
      metadata: { filePath: "x.pdf", pageCount: 0, authors: [], textSample: "" },
      queries: [],
      fetcher: fetch,
      limit: 10
    };
  }
});
