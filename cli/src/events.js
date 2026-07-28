import { normalizeSeverity } from "./findings.js";

const SEVERITY_MAP = {
  CRITICAL: "critical",
  WARNING: "major",
  SUGGESTION: "minor",
};

/**
 * Map CodeFerret's authoritative 3-tier severity onto CodeRabbit's wire names.
 * Lossy by design: "trivial" and "info" are never emitted.
 *
 * Normalizes through findings.js so this agrees with the report and history
 * tallies on exactly which strings count as which tier -- otherwise an aliased
 * severity like "MAJOR" is counted as a warning in the report while going out
 * on the wire as "minor".
 */
export function mapSeverity(severity) {
  return SEVERITY_MAP[normalizeSeverity(severity)] ?? "minor";
}

/** Convert a .ferret/last-review.json finding to a CodeRabbit-shaped event. */
export function toWireFinding(finding) {
  return {
    type: "finding",
    severity: mapSeverity(finding.severity),
    fileName: finding.file,
    line: finding.line ?? null,
    character: finding.character ?? null,
    codegenInstructions: finding.codegen_instructions || finding.explanation || "",
    suggestions: finding.patch ? [finding.patch] : [],
    comment: finding.message,
    vector: finding.vector,
    confidence: finding.confidence,
  };
}

/**
 * JSONL emitter. In plain mode every method is a no-op — the human-readable
 * report is produced separately by report.js.
 */
export function createEmitter({ agent = false, stdout = process.stdout } = {}) {
  const write = (obj) => {
    if (agent) stdout.write(`${JSON.stringify(obj)}\n`);
  };
  return {
    agent,
    reviewContext(ctx) { write({ type: "review_context", ...ctx }); },
    status(status) { write({ type: "status", status }); },
    heartbeat() { write({ type: "heartbeat", ts: new Date().toISOString() }); },
    finding(finding) { write(toWireFinding(finding)); },
    // `--show-prompts --agent` has to stay parseable like every other --agent
    // path; the prompts are free-form multi-line text, so they ship as one
    // event rather than being written raw to a stream declared to be JSONL.
    prompts(list) { write({ type: "prompts", prompts: list }); },
    complete(result) { write({ type: "complete", ...result }); },
    error(err) { write({ type: "error", ...err }); },
  };
}

/** The documented empty-diff sequence: context, review_skipped, complete. */
export function emitNoChanges(emitter, context) {
  emitter.reviewContext(context);
  emitter.status("review_skipped");
  emitter.complete({
    status: "review_skipped",
    findings: 0,
    message: "No changes detected",
  });
}
