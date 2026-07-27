import { readFile } from "node:fs/promises";
import { join } from "node:path";

const SEVERITY_ORDER = { CRITICAL: 0, WARNING: 1, SUGGESTION: 2 };
const CONFIDENCE_ORDER = { HIGH: 0, MEDIUM: 1, LOW: 2 };

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
  return [...findings].sort((a, b) => {
    const sev = (SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3);
    if (sev !== 0) return sev;
    return (CONFIDENCE_ORDER[a.confidence] ?? 3) - (CONFIDENCE_ORDER[b.confidence] ?? 3);
  });
}
