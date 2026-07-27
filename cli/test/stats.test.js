import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendHistory, readHistory, aggregate, readStats, formatStats, FERRET_GITIGNORE,
} from "../src/stats.js";

const newDir = () => join(mkdtempSync(join(tmpdir(), "ferret-stats-")), ".ferret");

const ENTRY = {
  ts: "2026-07-27T10:00:00Z",
  target: "all",
  branch: "main",
  commit: "abc1234",
  by_severity: { CRITICAL: 1, WARNING: 2, SUGGESTION: 0 },
  by_vector: { CONCURRENCY: 1, LOGIC: 2 },
  suppressed: 1,
  deduped: 2,
  duration_ms: 4000,
  agent: "claude",
  light: false,
};

test("appendHistory creates .ferret, the gitignore, and one line per review", async () => {
  const dir = newDir();
  await appendHistory(dir, ENTRY);
  await appendHistory(dir, { ...ENTRY, ts: "2026-07-27T11:00:00Z" });
  const raw = readFileSync(join(dir, "history.jsonl"), "utf8").trimEnd().split("\n");
  assert.equal(raw.length, 2);
  assert.equal(JSON.parse(raw[0]).branch, "main");
  assert.ok(existsSync(join(dir, ".gitignore")));
  // Verify .gitignore content matches FERRET_GITIGNORE
  const gitignoreContent = readFileSync(join(dir, ".gitignore"), "utf8");
  assert.equal(gitignoreContent, FERRET_GITIGNORE);
});

test("the generated gitignore keeps review-cache.json shareable", () => {
  assert.match(FERRET_GITIGNORE, /^\*$/m);
  assert.match(FERRET_GITIGNORE, /^!review-cache\.json$/m);
  assert.match(FERRET_GITIGNORE, /^!\.gitignore$/m);
});

test("readHistory skips malformed lines", async () => {
  const dir = newDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "history.jsonl"), `${JSON.stringify(ENTRY)}\n{broken\n`);
  assert.equal((await readHistory(dir)).length, 1);
});

test("appendHistory recovers from half-written lines (no trailing newline)", async () => {
  const dir = newDir();
  mkdirSync(dir, { recursive: true });
  // Simulate an interrupted write by creating a file with no trailing newline
  const firstEntry = { ...ENTRY, ts: "2026-07-27T10:00:00Z" };
  writeFileSync(join(dir, "history.jsonl"), JSON.stringify(firstEntry)); // no \n
  // Now append a new entry
  const secondEntry = { ...ENTRY, ts: "2026-07-27T11:00:00Z" };
  await appendHistory(dir, secondEntry);
  // Both entries should be readable, not silently lost
  const entries = await readHistory(dir);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].ts, "2026-07-27T10:00:00Z");
  assert.equal(entries[1].ts, "2026-07-27T11:00:00Z");
});

test("readHistory returns an empty array when there is no history", async () => {
  assert.deepEqual(await readHistory(newDir()), []);
});

test("aggregate totals reviews, severities, vectors, and duration", () => {
  // Use 3 entries with distinct durations: 2000, 4000, 12000 (mean=6000, median=4000)
  const stats = aggregate([
    { ...ENTRY, duration_ms: 2000 },
    { ...ENTRY, ts: "2026-07-27T11:00:00Z", duration_ms: 4000 },
    { ...ENTRY, ts: "2026-07-27T12:00:00Z", duration_ms: 12000 },
  ]);
  assert.equal(stats.reviews, 3);
  assert.equal(stats.findings_total, 9); // 3 entries × 3 findings each
  assert.equal(stats.by_severity.CRITICAL, 3);
  assert.equal(stats.by_vector.LOGIC, 6);
  assert.equal(stats.suppressed_total, 3);
  assert.equal(stats.deduped_total, 6);
  assert.equal(stats.avg_duration_ms, 6000); // mean of 2000, 4000, 12000
  assert.equal(stats.first_review, "2026-07-27T10:00:00Z");
  assert.equal(stats.last_review, "2026-07-27T12:00:00Z");
});

test("aggregate handles an empty history", () => {
  const stats = aggregate([]);
  assert.equal(stats.reviews, 0);
  assert.equal(stats.findings_total, 0);
  assert.equal(stats.avg_duration_ms, 0);
});

test("readStats builds stats.json on first run", async () => {
  const dir = newDir();
  await appendHistory(dir, ENTRY);
  const stats = await readStats(dir, {});
  assert.equal(stats.reviews, 1);
  assert.ok(existsSync(join(dir, "stats.json")));
});

test("readStats --rebuild recomputes from history and overwrites a stale cache", async () => {
  const dir = newDir();
  await appendHistory(dir, ENTRY);
  writeFileSync(join(dir, "stats.json"), JSON.stringify({ reviews: 999 }));
  assert.equal((await readStats(dir, {})).reviews, 999);
  assert.equal((await readStats(dir, { rebuild: true })).reviews, 1);
});

test("formatStats renders a human-readable summary", () => {
  const out = formatStats(aggregate([ENTRY]));
  assert.match(out, /Reviews:\s+1/);
  assert.match(out, /CRITICAL/);
  assert.match(out, /CONCURRENCY/);
});

test("formatStats reports an empty history plainly", () => {
  assert.match(formatStats(aggregate([])), /No reviews recorded yet/);
});
