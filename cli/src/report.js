import { sortFindings, tallySeverities } from "./findings.js";

export function formatFinding(finding) {
  const loc = `${finding.file}:${finding.line ?? 1}:${finding.character ?? 1}`;
  const head = `[${finding.severity} · ${finding.vector} · ${finding.confidence}] ${loc}`;
  const lines = [head, `  ${finding.message}`];
  if (finding.explanation) lines.push(`  ${finding.explanation}`);
  if (finding.patch) lines.push("  Fix available — run /code-ferret:triage to apply.");
  return lines.join("\n");
}

export function formatReport(review, tally = {}) {
  const { suppressed = 0, deduped = 0 } = tally;
  const findings = sortFindings(review.findings ?? []);
  // Shared with review.js's history tally, so the printed count and the
  // recorded count can never disagree on a lowercase, aliased, or
  // prototype-colliding severity string from the agent's JSON.
  const { counts, unknown } = tallySeverities(findings);
  const body = findings.map(formatFinding).join("\n\n");
  // An unrecognized severity is surfaced rather than dropped: the finding is
  // printed above, so omitting it here would make the tally contradict the
  // body it closes.
  const unknownNote = unknown ? ` · ${unknown} unrecognized severity` : "";
  const tallyLine =
    `${counts.CRITICAL} critical · ${counts.WARNING} warning · ` +
    `${counts.SUGGESTION} suggestions${unknownNote} ` +
    `(${suppressed} suppressed by cache, ${deduped} deduped)`;
  return body ? `${body}\n\n${tallyLine}` : tallyLine;
}

export function formatCandidates(candidates, note) {
  const lines = ["Narrower scopes found in this diff:", ""];
  for (const c of candidates) {
    const fit = c.fits ? "fits" : "over limit";
    lines.push(`  ${c.command}`);
    lines.push(`    ~${c.files} files (${fit})`);
  }
  lines.push("", note);
  return lines.join("\n");
}
