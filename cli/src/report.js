import { sortFindings } from "./findings.js";

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
  const counts = { CRITICAL: 0, WARNING: 0, SUGGESTION: 0 };
  for (const f of findings) {
    if (counts[f.severity] !== undefined) counts[f.severity] += 1;
  }
  const body = findings.map(formatFinding).join("\n\n");
  const tallyLine =
    `${counts.CRITICAL} critical · ${counts.WARNING} warning · ` +
    `${counts.SUGGESTION} suggestions ` +
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
