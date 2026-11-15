import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function makeTempRoot(): string {
  return mkdtempSync(path.join(os.tmpdir(), "search-bibtex-cli-batch-"));
}

describe("batch CLI", () => {
  it("prints batch help with the budget and result-dir options", () => {
    const result = runCli(["batch", "--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: search-bibtex batch [options] <input>");
    expect(result.stdout).toContain("--result-dir <path>");
    expect(result.stdout).toContain("--source-concurrency <count>");
    expect(result.stdout).toContain("--source-budget <seconds>");
    expect(result.stdout).toContain("--failure-threshold <count>");
  });

  it("fails before searching when the result dir is not a directory", () => {
    const tempRoot = makeTempRoot();
    const blockingFile = path.join(tempRoot, "blocker");
    writeFileSync(blockingFile, "not a directory");
    const manifest = path.join(tempRoot, "manifest.txt");
    writeFileSync(manifest, [
      "# a comment",
      "",
      path.join(tempRoot, "a.pdf")
    ].join("\n"));

    const result = runCli([
      "batch",
      manifest,
      "--output", path.join(tempRoot, "out.bib"),
      "--result-dir", blockingFile
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Expected a directory");
  });
});

function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  return spawnSync(pnpmCommand(), ["exec", "tsx", "src/main.ts", ...args], {
    cwd: projectDir,
    encoding: "utf8"
  });
}

function pnpmCommand(): string {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}
