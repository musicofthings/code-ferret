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

test("readHistory returns an empty array when there is no history", async () => {
  assert.deepEqual(await readHistory(newDir()), []);
});

test("aggregate totals reviews, severities, vectors, and duration", () => {
  const stats = aggregate([ENTRY, { ...ENTRY, ts: "2026-07-27T12:00:00Z", duration_ms: 8000 }]);
  assert.equal(stats.reviews, 2);
  assert.equal(stats.findings_total, 6);
  assert.equal(stats.by_severity.CRITICAL, 2);
  assert.equal(stats.by_vector.LOGIC, 4);
  assert.equal(stats.suppressed_total, 2);
  assert.equal(stats.deduped_total, 4);
  assert.equal(stats.avg_duration_ms, 6000);
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
