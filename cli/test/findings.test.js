import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readReview, readPrompts, sortFindings } from "../src/findings.js";

function ferretDirWith(files) {
  const dir = join(mkdtempSync(join(tmpdir(), "ferret-find-")), ".ferret");
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), body);
  }
  return dir;
}

test("readReview parses last-review.json", async () => {
  const dir = ferretDirWith({
    "last-review.json": JSON.stringify({ target: "all", findings: [{ id: "f1" }] }),
  });
  const review = await readReview(dir);
  assert.equal(review.target, "all");
  assert.equal(review.findings.length, 1);
});

test("readReview returns null when the file is missing", async () => {
  assert.equal(await readReview(ferretDirWith({})), null);
});

test("readReview returns null on malformed JSON", async () => {
  assert.equal(await readReview(ferretDirWith({ "last-review.json": "{not json" })), null);
});

test("readPrompts parses last-prompts.json", async () => {
  const dir = ferretDirWith({
    "last-prompts.json": JSON.stringify({ prompts: [{ name: "review", text: "hi" }] }),
  });
  assert.equal((await readPrompts(dir)).prompts[0].name, "review");
});

test("sortFindings orders by severity then confidence", () => {
  const sorted = sortFindings([
    { id: "a", severity: "SUGGESTION", confidence: "HIGH" },
    { id: "b", severity: "CRITICAL", confidence: "MEDIUM" },
    { id: "c", severity: "CRITICAL", confidence: "HIGH" },
    { id: "d", severity: "WARNING", confidence: "LOW" },
  ]);
  assert.deepEqual(sorted.map((f) => f.id), ["c", "b", "d", "a"]);
});
