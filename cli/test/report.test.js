import { test } from "node:test";
import assert from "node:assert/strict";
import { formatFinding, formatReport, formatCandidates } from "../src/report.js";

const FINDING = {
  file: "src/pay.ts",
  line: 84,
  character: 14,
  severity: "CRITICAL",
  vector: "CONCURRENCY",
  confidence: "HIGH",
  message: "Race condition during balance debit.",
  explanation: "Two concurrent debits read the same balance.",
  patch: "--- a/src/pay.ts\n",
};

test("formatFinding emits a clickable file:line:col header", () => {
  const out = formatFinding(FINDING);
  assert.match(out, /\[CRITICAL · CONCURRENCY · HIGH\] src\/pay\.ts:84:14/);
  assert.match(out, /Race condition during balance debit\./);
  assert.match(out, /Two concurrent debits read the same balance\./);
  assert.match(out, /Fix available/);
});

test("formatFinding omits the fix line when there is no patch", () => {
  assert.doesNotMatch(formatFinding({ ...FINDING, patch: null }), /Fix available/);
});

test("formatFinding defaults a missing character to 1", () => {
  assert.match(formatFinding({ ...FINDING, character: undefined }), /src\/pay\.ts:84:1\b/);
});

test("formatReport closes with an honest tally", () => {
  const out = formatReport(
    { target: "all", findings: [FINDING, { ...FINDING, severity: "WARNING" }] },
    { suppressed: 4, deduped: 2 },
  );
  assert.match(out, /1 critical · 1 warning · 0 suggestions/);
  assert.match(out, /4 suppressed by cache/);
  assert.match(out, /2 deduped/);
});

test("formatReport reports a clean run", () => {
  const out = formatReport({ target: "all", findings: [] }, { suppressed: 0, deduped: 0 });
  assert.match(out, /0 critical · 0 warning · 0 suggestions/);
});

test("formatCandidates lists commands with counts and fit indicators", () => {
  const out = formatCandidates(
    [
      { command: "ferret review --committed", files: 12, fits: true },
      { command: "ferret review --dir src/api", files: 61, fits: false },
    ],
    "Choose one and rerun manually.",
  );
  assert.match(out, /Narrower scopes found in this diff/);
  assert.match(out, /ferret review --committed/);
  assert.match(out, /12 files/);
  assert.match(out, /over limit/);
  assert.match(out, /Choose one and rerun manually\./);
});
