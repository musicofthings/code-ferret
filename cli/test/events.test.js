import { test } from "node:test";
import assert from "node:assert/strict";
import { mapSeverity, toWireFinding, createEmitter, emitNoChanges } from "../src/events.js";

function capture() {
  const lines = [];
  return {
    stdout: { write: (s) => lines.push(s) },
    events: () => lines.join("").trimEnd().split("\n").filter(Boolean).map((l) => JSON.parse(l)),
  };
}

test("severity maps the 3-tier taxonomy onto CodeRabbit names", () => {
  assert.equal(mapSeverity("CRITICAL"), "critical");
  assert.equal(mapSeverity("WARNING"), "major");
  assert.equal(mapSeverity("SUGGESTION"), "minor");
  assert.equal(mapSeverity("unknown"), "minor");
});

test("toWireFinding maps CodeFerret fields onto the wire contract", () => {
  const wire = toWireFinding({
    file: "src/pay.ts",
    line: 84,
    character: 14,
    severity: "CRITICAL",
    vector: "CONCURRENCY",
    confidence: "HIGH",
    message: "Race condition during balance debit.",
    explanation: "Two concurrent debits read the same balance.",
    codegen_instructions: "Wrap the read-modify-write in a transaction.",
    patch: "--- a/src/pay.ts\n+++ b/src/pay.ts\n",
  });
  assert.equal(wire.type, "finding");
  assert.equal(wire.severity, "critical");
  assert.equal(wire.fileName, "src/pay.ts");
  assert.equal(wire.line, 84);
  assert.equal(wire.character, 14);
  assert.equal(wire.codegenInstructions, "Wrap the read-modify-write in a transaction.");
  assert.deepEqual(wire.suggestions, ["--- a/src/pay.ts\n+++ b/src/pay.ts\n"]);
  assert.equal(wire.comment, "Race condition during balance debit.");
  assert.equal(wire.vector, "CONCURRENCY");
  assert.equal(wire.confidence, "HIGH");
});

test("codegenInstructions falls back to explanation, suggestions to empty", () => {
  const wire = toWireFinding({
    file: "a.ts",
    severity: "WARNING",
    message: "m",
    explanation: "why it breaks",
    patch: null,
  });
  assert.equal(wire.codegenInstructions, "why it breaks");
  assert.deepEqual(wire.suggestions, []);
});

test("emitter writes one JSON object per line in agent mode", () => {
  const cap = capture();
  const e = createEmitter({ agent: true, stdout: cap.stdout });
  e.reviewContext({ target: "all", branch: "main", files: 2, agent: "claude" });
  e.status("collecting_context");
  e.heartbeat();
  e.complete({ status: "completed", findings: 0, suppressed: 0, deduped: 0 });
  const events = cap.events();
  assert.deepEqual(events.map((x) => x.type), [
    "review_context", "status", "heartbeat", "complete",
  ]);
  assert.equal(events[0].target, "all");
  assert.ok(events[2].ts);
});

test("emitter writes nothing in plain mode", () => {
  const cap = capture();
  const e = createEmitter({ agent: false, stdout: cap.stdout });
  e.status("collecting_context");
  e.complete({ status: "completed", findings: 0 });
  assert.deepEqual(cap.events(), []);
});

test("emitNoChanges emits the documented empty-diff sequence", () => {
  const cap = capture();
  const e = createEmitter({ agent: true, stdout: cap.stdout });
  emitNoChanges(e, { target: "all", branch: "main", files: 0, agent: "claude" });
  const events = cap.events();
  assert.deepEqual(events.map((x) => x.type), ["review_context", "status", "complete"]);
  assert.equal(events[1].status, "review_skipped");
  assert.equal(events[2].status, "review_skipped");
  assert.equal(events[2].findings, 0);
  assert.equal(events[2].message, "No changes detected");
});

test("severity is case-insensitive", () => {
  assert.equal(mapSeverity("critical"), "critical");
  assert.equal(mapSeverity("Warning"), "major");
});

test("emitter.finding() emits wire-formatted finding as single JSON line", () => {
  const cap = capture();
  const e = createEmitter({ agent: true, stdout: cap.stdout });
  e.finding({
    file: "src/util.ts",
    line: 42,
    severity: "WARNING",
    message: "Multi-line\nmessage content",
    patch: "--- a/src/util.ts\n+++ b/src/util.ts\n@@ -42,3 +42,5 @@\n content with\n multiple lines\n here",
  });
  const rawOutput = cap.stdout.write.toString();
  // Verify exactly one line was written (ends with \n, contains no \n in the middle)
  const lines = cap.events();
  assert.equal(lines.length, 1);
  assert.equal(lines[0].type, "finding");
  assert.equal(lines[0].fileName, "src/util.ts");
  assert.equal(lines[0].comment, "Multi-line\nmessage content");
  assert.deepEqual(lines[0].suggestions[0], "--- a/src/util.ts\n+++ b/src/util.ts\n@@ -42,3 +42,5 @@\n content with\n multiple lines\n here");
});

test("emitter.error() emits error type and fields", () => {
  const cap = capture();
  const e = createEmitter({ agent: true, stdout: cap.stdout });
  e.error({ message: "Parse error on line 12", candidates: ["foo", "bar"] });
  const events = cap.events();
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "error");
  assert.equal(events[0].message, "Parse error on line 12");
  assert.deepEqual(events[0].candidates, ["foo", "bar"]);
});

test("toWireFinding preserves zero for line and character", () => {
  const wire = toWireFinding({
    file: "a.ts",
    line: 0,
    character: 0,
    severity: "WARNING",
    message: "m",
  });
  assert.equal(wire.line, 0);
  assert.equal(wire.character, 0);
});
