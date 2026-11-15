import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createDefaultBatchInputProcessor, runBatch } from "../src/batch.js";
import type { FetchLike } from "../src/http.js";
import type { PdfMetadataCandidate } from "../src/types.js";

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "search-bibtex-e2e-"));
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

/**
 * Fetcher that serves DBLP and Crossref successfully (both returning the same
 * DOI so the candidates must merge into one paper), while Semantic Scholar
 * always fails and must degrade to an absent source.
 */
const fakeFetch: FetchLike = async (input) => {
  const url = String(input);

  if (url.startsWith("https://dblp.org/search/publ/api")) {
    return jsonResponse({
      result: {
        hits: {
          hit: [{
            info: {
              title: "Self-Instruct Aligning Language Models",
              authors: { author: [{ text: "Yizhong Wang" }] },
              venue: "ACL",
              year: "2023",
              key: "conf/acl/WangK23",
              doi: "10.18653/v1/2023.acl-long.754"
            }
          }]
        }
      }
    });
  }

  if (url === "https://dblp.org/rec/conf/acl/WangK23.bib") {
    return new Response("@inproceedings{WangK23, title = {Self-Instruct}}", {
      status: 200,
      headers: { "content-type": "application/x-bibtex" }
    });
  }

  if (url.startsWith("https://doi.org/")) {
    return new Response("@misc{DoiFallback, title = {Self-Instruct}}", {
      status: 200,
      headers: { "content-type": "application/x-bibtex" }
    });
  }

  if (url.startsWith("https://api.crossref.org/works")) {
    return jsonResponse({
      message: {
        // Shape of the single-record /works/{doi} endpoint used when the input
        // already carries a DOI.
        title: ["Self-Instruct: Aligning Language Models with Self-Generated Instructions"],
        DOI: "10.18653/v1/2023.acl-long.754",
        issued: { "date-parts": [[2023]] },
        "container-title": ["ACL"],
        author: [
          { given: "Yizhong", family: "Wang" },
          { given: "Yeganeh", family: "Kordi" }
        ]
      }
    });
  }

  if (url.startsWith("https://api.semanticscholar.org/")) {
    return new Response("rate limited", { status: 429 });
  }

  throw new Error(`Unexpected URL ${url}`);
};

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

describe("batch end-to-end with mocked network", () => {
  it("degrades a failing source to absent, merges same-DOI candidates, and writes one entry", async () => {
    const resultDir = path.join(tempRoot, "results");
    await mkdir(resultDir);
    const bibPath = path.join(tempRoot, "out.bib");
    const pdfPath = path.join(tempRoot, "self-instruct.pdf");
    await writeFile(pdfPath, Buffer.from("not-a-real-pdf"));

    const metadata: PdfMetadataCandidate = {
      filePath: pdfPath,
      pageCount: 1,
      title: "Self-Instruct Aligning Language Models",
      authors: ["Yizhong Wang"],
      year: 2023,
      doi: "10.18653/v1/2023.acl-long.754",
      textSample: ""
    };
    const processor = createDefaultBatchInputProcessor({
      metadataFor: (filePath) => (filePath === pdfPath ? metadata : undefined)
    });

    const result = await runBatch({
      inputs: { paths: [pdfPath], duplicateCount: 0 },
      bibPath,
      resultDir,
      budget: { perSourceConcurrency: 2, perSourceBudgetMs: 60_000, failureThreshold: 3 },
      searchOptions: {
        fetcher: fakeFetch,
        preferences: {
          sourcePriority: ["dblp", "crossref", "semantic-scholar"],
          limit: 5
        },
        timeoutMs: 5000
      },
      processInput: processor
    });

    expect(result.summary.hits).toBe(1);
    expect(result.summary.failures).toBe(0);

    const record = result.records[0];
    expect(record.status).toBe("hit");
    // DBLP + Crossref share a DOI, so the two candidates collapse into one.
    expect(record.mergedCandidateCount).toBe(2);
    expect(record.contributingSources).toEqual(expect.arrayContaining(["dblp", "crossref"]));

    const semantic = result.summary.sources.find((source) => source.source === "semantic-scholar");
    expect(semantic?.failureCount).toBe(1);
    const dblp = result.summary.sources.find((source) => source.source === "dblp");
    expect(dblp?.successCount).toBeGreaterThan(0);
    expect(dblp?.averageElapsedMs).toBeGreaterThanOrEqual(0);

    // One JSON hit record corresponds to exactly one .bib entry.
    const bibText = await readFile(bibPath, "utf8");
    expect((bibText.match(/@[A-Za-z]+\{/g) ?? []).length).toBe(1);
    expect(bibText).toContain(`{${record.citationKey},`);
  });

  it("reports a miss (not a file failure) when every source is unavailable", async () => {
    const resultDir = path.join(tempRoot, "results-miss");
    await mkdir(resultDir);
    const bibPath = path.join(tempRoot, "miss.bib");
    const pdfPath = path.join(tempRoot, "unknown.pdf");

    const alwaysFails: FetchLike = async () => new Response("boom", { status: 500 });
    const metadata: PdfMetadataCandidate = {
      filePath: pdfPath,
      pageCount: 1,
      title: "Totally Unknown Paper Title",
      authors: ["Nobody Known"],
      textSample: ""
    };

    const result = await runBatch({
      inputs: { paths: [pdfPath], duplicateCount: 0 },
      bibPath,
      resultDir,
      budget: { perSourceConcurrency: 2, perSourceBudgetMs: 60_000, failureThreshold: 5 },
      searchOptions: {
        fetcher: alwaysFails,
        preferences: { sourcePriority: ["dblp", "crossref"], limit: 5 },
        timeoutMs: 5000
      },
      processInput: createDefaultBatchInputProcessor({ metadataFor: () => metadata })
    });

    expect(result.summary.misses).toBe(1);
    expect(result.summary.failures).toBe(0);
    const queried = result.summary.sources.filter((source) =>
      source.source === "dblp" || source.source === "crossref"
    );
    expect(queried).toHaveLength(2);
    expect(queried.every((source) => source.failureCount > 0)).toBe(true);
    expect(queried.every((source) => source.averageElapsedMs >= 0)).toBe(true);
  });
});
