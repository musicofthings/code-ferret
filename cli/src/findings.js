import { readFile } from "node:fs/promises";
import { join } from "node:path";

const SEVERITY_ORDER = { CRITICAL: 0, WARNING: 1, SUGGESTION: 2 };
const CONFIDENCE_ORDER = { HIGH: 0, MEDIUM: 1, LOW: 2 };

/**
 * Severity strings accepted as one of the three internal tiers. Includes the
 * CodeRabbit wire names, because events.js emits WARNING as "major" and
 * SUGGESTION as "minor" -- an agent that has seen that vocabulary writing
 * "MAJOR" back into last-review.json is entirely realistic, and silently
 * discarding it is worse than accepting it.
 */
const SEVERITY_ALIASES = {
  CRITICAL: "CRITICAL",
  WARNING: "WARNING",
  SUGGESTION: "SUGGESTION",
  MAJOR: "WARNING",
  MINOR: "SUGGESTION",
};

/**
 * Normalize an agent-authored severity to an internal tier, or null when it is
 * not recognized. Callers must account for null rather than skip it: findings
 * with an unrecognized severity used to be printed in the report body while
 * being dropped from both the closing tally and history.jsonl, so the report
 * could list findings above a "0 critical · 0 warning · 0 suggestions" line
 * and `ferret stats` would under-count forever.
 *
 * The value comes from LLM-authored JSON, so it is untrusted: uppercasing plus
 * an Object.hasOwn check keeps a severity like "constructor" from resolving
 * through Object.prototype.
 */
export function normalizeSeverity(severity) {
  const key = String(severity ?? "").toUpperCase();
  return Object.hasOwn(SEVERITY_ALIASES, key) ? SEVERITY_ALIASES[key] : null;
}

/** Bucket findings by normalized severity, counting unrecognized ones. */
export function tallySeverities(findings) {
  const counts = { CRITICAL: 0, WARNING: 0, SUGGESTION: 0 };
  let unknown = 0;
  for (const finding of findings) {
    const sev = normalizeSeverity(finding.severity);
    if (sev) counts[sev] += 1;
    else unknown += 1;
  }
  return { counts, unknown };
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

/** Read the findings the host agent wrote. This is the CLI's real contract. */
export function readReview(ferretDir) {
  return readJson(join(ferretDir, "last-review.json"));
}

export function readPrompts(ferretDir) {
  return readJson(join(ferretDir, "last-prompts.json"));
}

/** CRITICAL → WARNING → SUGGESTION, HIGH confidence first within a tier. */
export function sortFindings(findings) {
  const rank = (f) => SEVERITY_ORDER[normalizeSeverity(f.severity)] ?? 3;
  return [...findings].sort((a, b) => {
    const sev = rank(a) - rank(b);
    if (sev !== 0) return sev;
    return (CONFIDENCE_ORDER[a.confidence] ?? 3) - (CONFIDENCE_ORDER[b.confidence] ?? 3);
  });
}
