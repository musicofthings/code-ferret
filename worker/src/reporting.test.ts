import { describe, expect, it } from "vitest";
import {
  SUMMARY_START,
  WALKTHROUGH_MARKER,
  extractLinkedIssues,
  fallbackReviewReport,
  mergeSummaryIntoBody,
  parseReviewReportText,
  renderSummary,
  renderWalkthrough,
  type ReviewReport,
} from "./reporting";
import type { Finding } from "./index";

const report: ReviewReport = {
  summary: "Adds token rotation and updates its tests.",
  risk: "MEDIUM",
  riskRationale: "Authentication behavior changes.",
  walkthrough: [
    {
      path: "src/auth.ts",
      summary: "Rotates expired tokens.",
      risk: "MEDIUM",
      keyChanges: ["Adds expiry validation."],
    },
  ],
  requirements: [
    { requirement: "Expired tokens are rejected", status: "MET", evidence: "The expiry branch returns 401." },
  ],
};

describe("review report validation", () => {
  it("parses a structured report", () => {
    const raw = JSON.stringify({
      summary: report.summary,
      risk: report.risk,
      risk_rationale: report.riskRationale,
      walkthrough: report.walkthrough.map((entry) => ({
        path: entry.path,
        summary: entry.summary,
        risk: entry.risk,
        key_changes: entry.keyChanges,
      })),
      requirements: report.requirements,
    });
    expect(parseReviewReportText(raw)).toEqual(report);
  });

  it("rejects unsafe walkthrough paths and invalid requirement states", () => {
    const base = {
      summary: "Summary",
      risk: "LOW",
      risk_rationale: "Low risk.",
      walkthrough: [{ path: "../secret", summary: "Bad", risk: "LOW", key_changes: [] }],
      requirements: [],
    };
    expect(() => parseReviewReportText(JSON.stringify(base))).toThrow("path is invalid");
    expect(() =>
      parseReviewReportText(
        JSON.stringify({ ...base, walkthrough: [], requirements: [{ requirement: "R", status: "YES", evidence: "E" }] }),
      ),
    ).toThrow("status is invalid");
  });
});

describe("linked issues", () => {
  it("extracts and deduplicates local, qualified, and URL references", () => {
    expect(
      extractLinkedIssues(
        "Fixes #12 and refs owner/other#34. See https://github.com/acme/project/issues/56 and issue #12.",
        "acme/project",
      ),
    ).toEqual([
      { repo: "acme/project", number: 56 },
      { repo: "owner/other", number: 34 },
      { repo: "acme/project", number: 12 },
    ]);
  });
});

describe("report rendering", () => {
  it("replaces an existing marked summary without changing user content", () => {
    const first = mergeSummaryIntoBody("User description", renderSummary(report, true, true));
    const second = mergeSummaryIntoBody(first, renderSummary({ ...report, summary: "Updated summary." }, true, true));
    expect(second).toContain("User description");
    expect(second).toContain("Updated summary.");
    expect(second).not.toContain("Adds token rotation");
    expect(second.match(new RegExp(SUMMARY_START, "g"))).toHaveLength(1);
  });

  it("renders a walkthrough and linked requirements", () => {
    const rendered = renderWalkthrough(report, "incremental");
    expect(rendered).toContain(WALKTHROUGH_MARKER);
    expect(rendered).toContain("CodeFerret incremental walkthrough");
    expect(rendered).toContain("Expired tokens are rejected");
  });

  it("derives deterministic risk when report generation fails", () => {
    const finding: Finding = {
      file: "src/auth.ts",
      line: 1,
      character: 1,
      severity: "CRITICAL",
      vector: "SECURITY",
      confidence: "HIGH",
      message: "Authentication bypass",
      explanation: "A missing check admits an expired token.",
      patch: null,
    };
    expect(fallbackReviewReport(["src/auth.ts"], [finding]).risk).toBe("HIGH");
  });
});
