import { test } from "node:test";
import assert from "node:assert/strict";
import { computeCandidates, topDirectories } from "../src/candidates.js";

test("topDirectories counts by parent directory, descending", () => {
  const dirs = topDirectories(["src/a.ts", "src/b.ts", "web/c.ts", "root.ts"]);
  assert.deepEqual(dirs, [["src", 2], [".", 1], ["web", 1]]);
});

test("computeCandidates offers committed and uncommitted scopes first", () => {
  const { candidates } = computeCandidates({
    files: Array.from({ length: 60 }, (_, i) => `src/f${i}.ts`),
    maxFiles: 50,
    committedFiles: ["src/a.ts"],
    uncommittedFiles: ["src/b.ts", "src/c.ts"],
  });
  assert.equal(candidates[0].command, "ferret review --committed");
  assert.equal(candidates[0].files, 1);
  assert.equal(candidates[0].fits, true);
  assert.equal(candidates[1].command, "ferret review --uncommitted");
  assert.equal(candidates[1].files, 2);
});

test("computeCandidates falls back to --dir scopes and caps at five", () => {
  const files = [];
  for (const dir of ["a", "b", "c", "d", "e", "f", "g"]) {
    for (let i = 0; i < 10; i += 1) files.push(`${dir}/f${i}.ts`);
  }
  const { candidates } = computeCandidates({ files, maxFiles: 50 });
  assert.equal(candidates.length, 5);
  assert.ok(candidates.every((c) => c.command.startsWith("ferret review --dir ")));
});

test("candidates carry a conservative fit indicator", () => {
  const { candidates } = computeCandidates({
    files: Array.from({ length: 60 }, (_, i) => `src/f${i}.ts`),
    maxFiles: 50,
  });
  assert.equal(candidates[0].fits, false);
  assert.equal(candidates[0].files, 60);
});

test("candidatesNote names the file count and the limit", () => {
  const { candidatesNote } = computeCandidates({
    files: Array.from({ length: 61 }, (_, i) => `src/f${i}.ts`),
    maxFiles: 50,
  });
  assert.match(candidatesNote, /61/);
  assert.match(candidatesNote, /50/);
  assert.match(candidatesNote, /rerun/i);
});

test("empty scopes are not offered as candidates", () => {
  const { candidates } = computeCandidates({
    files: ["a/x.ts"],
    maxFiles: 50,
    committedFiles: [],
    uncommittedFiles: [],
  });
  assert.ok(candidates.every((c) => !c.command.includes("--committed")));
  assert.ok(candidates.every((c) => !c.command.includes("--uncommitted")));
});

test("fits boundary: exactly maxFiles is treated as fitting", () => {
  const maxFiles = 50;
  const committedFilesAtBoundary = Array.from({ length: maxFiles }, (_, i) => `f${i}.ts`);
  const committedFilesAboveBoundary = Array.from({ length: maxFiles + 1 }, (_, i) => `f${i}.ts`);
  const files = Array.from({ length: 100 }, (_, i) => `src/f${i}.ts`);

  // Test at boundary: should fit
  const resultAtBoundary = computeCandidates({
    files,
    maxFiles,
    committedFiles: committedFilesAtBoundary,
  });
  const committedCandidate = resultAtBoundary.candidates.find((c) => c.command === "ferret review --committed");
  assert.ok(committedCandidate, "committed candidate should be present");
  assert.equal(committedCandidate.files, maxFiles);
  assert.equal(committedCandidate.fits, true, "exactly maxFiles should fit");

  // Test above boundary: should not fit
  const resultAboveBoundary = computeCandidates({
    files,
    maxFiles,
    committedFiles: committedFilesAboveBoundary,
  });
  const committedCandidateAbove = resultAboveBoundary.candidates.find((c) => c.command === "ferret review --committed");
  assert.ok(committedCandidateAbove, "committed candidate should be present");
  assert.equal(committedCandidateAbove.files, maxFiles + 1);
  assert.equal(committedCandidateAbove.fits, false, "maxFiles + 1 should not fit");
});
