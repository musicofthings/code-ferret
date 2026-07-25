import type { Finding } from "./index";

export type ReportRisk = "LOW" | "MEDIUM" | "HIGH";
export type RequirementStatus = "MET" | "PARTIAL" | "NOT_MET" | "UNKNOWN";

export interface WalkthroughEntry {
  path: string;
  summary: string;
  risk: ReportRisk;
  keyChanges: string[];
}

export interface RequirementAssessment {
  requirement: string;
  status: RequirementStatus;
  evidence: string;
}

export interface ReviewReport {
  summary: string;
  risk: ReportRisk;
  riskRationale: string;
  walkthrough: WalkthroughEntry[];
  requirements: RequirementAssessment[];
}

export interface LinkedIssueReference {
  repo: string;
  number: number;
}

export interface LinkedIssueContext extends LinkedIssueReference {
  title: string;
  body: string;
  url: string;
}

export const SUMMARY_START = "<!-- codeferret-summary-start -->";
export const SUMMARY_END = "<!-- codeferret-summary-end -->";
export const WALKTHROUGH_MARKER = "<!-- codeferret-walkthrough -->";

function safePath(value: string): boolean {
  return value.length > 0 && value.length <= 1024 && !value.startsWith("/") && !value.split("/").includes("..");
}

function isString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

export function parseReviewReportText(text: string): ReviewReport {
  const unfenced = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const parsed = JSON.parse(unfenced) as Record<string, unknown>;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("report must be an object");
  if (!isString(parsed.summary, 4000)) throw new Error("report summary is invalid");
  if (!(["LOW", "MEDIUM", "HIGH"] as unknown[]).includes(parsed.risk)) throw new Error("report risk is invalid");
  if (!isString(parsed.risk_rationale, 2000)) throw new Error("report risk rationale is invalid");

  if (!Array.isArray(parsed.walkthrough) || parsed.walkthrough.length > 100) {
    throw new Error("report walkthrough is invalid");
  }
  const walkthrough = parsed.walkthrough.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`walkthrough[${index}] is invalid`);
    }
    const item = value as Record<string, unknown>;
    if (typeof item.path !== "string" || !safePath(item.path)) throw new Error(`walkthrough[${index}].path is invalid`);
    if (!isString(item.summary, 1000)) throw new Error(`walkthrough[${index}].summary is invalid`);
    if (!(["LOW", "MEDIUM", "HIGH"] as unknown[]).includes(item.risk)) {
      throw new Error(`walkthrough[${index}].risk is invalid`);
    }
    if (
      !Array.isArray(item.key_changes) ||
      item.key_changes.length > 10 ||
      item.key_changes.some((change) => !isString(change, 500))
    ) {
      throw new Error(`walkthrough[${index}].key_changes is invalid`);
    }
    return {
      path: item.path,
      summary: item.summary,
      risk: item.risk as ReportRisk,
      keyChanges: item.key_changes as string[],
    };
  });

  if (!Array.isArray(parsed.requirements) || parsed.requirements.length > 20) {
    throw new Error("report requirements are invalid");
  }
  const requirements = parsed.requirements.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`requirements[${index}] is invalid`);
    }
    const item = value as Record<string, unknown>;
    if (!isString(item.requirement, 1000)) throw new Error(`requirements[${index}].requirement is invalid`);
    if (!(["MET", "PARTIAL", "NOT_MET", "UNKNOWN"] as unknown[]).includes(item.status)) {
      throw new Error(`requirements[${index}].status is invalid`);
    }
    if (!isString(item.evidence, 2000)) throw new Error(`requirements[${index}].evidence is invalid`);
    return {
      requirement: item.requirement,
      status: item.status as RequirementStatus,
      evidence: item.evidence,
    };
  });

  return {
    summary: parsed.summary,
    risk: parsed.risk as ReportRisk,
    riskRationale: parsed.risk_rationale,
    walkthrough,
    requirements,
  };
}

export function extractLinkedIssues(text: string, defaultRepo: string): LinkedIssueReference[] {
  const found = new Map<string, LinkedIssueReference>();
  const add = (repo: string, rawNumber: string) => {
    const number = Number(rawNumber);
    if (!Number.isSafeInteger(number) || number < 1 || found.size >= 5) return;
    found.set(`${repo.toLowerCase()}#${number}`, { repo, number });
  };

  for (const match of text.matchAll(/https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/issues\/(\d+)/gi)) {
    add(match[1], match[2]);
  }
  for (const match of text.matchAll(/\b([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)\b/g)) {
    add(match[1], match[2]);
  }
  for (const match of text.matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|refs?|related\s+to|issue)\s*:?[ \t]*#(\d+)/gi)) {
    add(defaultRepo, match[1]);
  }
  return Array.from(found.values());
}

export function fallbackReviewReport(paths: string[], findings: Finding[]): ReviewReport {
  const critical = findings.filter((finding) => finding.severity === "CRITICAL").length;
  const warning = findings.filter((finding) => finding.severity === "WARNING").length;
  const risk: ReportRisk = critical > 0 ? "HIGH" : warning > 0 ? "MEDIUM" : "LOW";
  return {
    summary: `This pull request changes ${paths.length} file(s). CodeFerret found ${critical} critical and ${warning} warning-level issue(s).`,
    risk,
    riskRationale: critical > 0 ? "At least one critical finding remains active." : warning > 0 ? "Warning-level findings require review." : "No critical or warning-level findings were detected.",
    walkthrough: paths.map((path) => ({ path, summary: "Changed by this pull request.", risk: "LOW", keyChanges: [] })),
    requirements: [],
  };
}

function tableEscape(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

export function renderSummary(report: ReviewReport, includeRisk: boolean, includeRequirements: boolean): string {
  const parts = [SUMMARY_START, "## CodeFerret summary", "", report.summary];
  if (includeRisk) parts.push("", `**Risk: ${report.risk}** — ${report.riskRationale}`);
  if (includeRequirements && report.requirements.length > 0) {
    parts.push("", "### Linked-issue requirements", "", "| Requirement | Status | Evidence |", "|---|---|---|");
    for (const item of report.requirements) {
      parts.push(`| ${tableEscape(item.requirement)} | ${item.status} | ${tableEscape(item.evidence)} |`);
    }
  }
  parts.push(SUMMARY_END);
  return parts.join("\n");
}

export function stripGeneratedSummary(currentBody: string): string {
  const markerPattern = new RegExp(`${SUMMARY_START}[\\s\\S]*?${SUMMARY_END}\\s*`, "g");
  return currentBody.replace(markerPattern, "").trimEnd();
}

export function mergeSummaryIntoBody(currentBody: string, renderedSummary: string): string {
  const cleanBody = stripGeneratedSummary(currentBody);
  const merged = cleanBody ? `${cleanBody}\n\n${renderedSummary}` : renderedSummary;
  if (merged.length > 65_000) throw new Error("PR description has insufficient room for CodeFerret summary");
  return merged;
}

export function renderWalkthrough(report: ReviewReport, mode: "full" | "incremental"): string {
  const lines = [
    WALKTHROUGH_MARKER,
    `## CodeFerret ${mode} walkthrough`,
    "",
    "| File | Risk | Change |",
    "|---|---|---|",
  ];
  for (const entry of report.walkthrough) {
    lines.push(`| \`${entry.path.replace(/`/g, "")}\` | ${entry.risk} | ${tableEscape(entry.summary)} |`);
    if (entry.keyChanges.length > 0) {
      lines.push("", `<details><summary>${entry.path} details</summary>`, "");
      lines.push(...entry.keyChanges.map((change) => `- ${change}`), "", "</details>");
    }
  }
  if (report.requirements.length > 0) {
    lines.push("", "### Linked-issue requirements", "", "| Requirement | Status | Evidence |", "|---|---|---|");
    for (const item of report.requirements) {
      lines.push(`| ${tableEscape(item.requirement)} | ${item.status} | ${tableEscape(item.evidence)} |`);
    }
  }
  return lines.join("\n").slice(0, 60_000);
}
