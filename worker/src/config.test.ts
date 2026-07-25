import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONFIG,
  changedPaths,
  filterFindingsBySeverity,
  filterIgnoredDiff,
  globMatches,
  parseCodeFerretConfig,
  pathReviewInstructions,
} from "./config";
import type { Finding } from "./index";

const diff = [
  "diff --git a/src/auth/login.ts b/src/auth/login.ts",
  "--- a/src/auth/login.ts",
  "+++ b/src/auth/login.ts",
  "@@ -1 +1 @@",
  "-old",
  "+new",
  "diff --git a/dist/bundle.js b/dist/bundle.js",
  "--- a/dist/bundle.js",
  "+++ b/dist/bundle.js",
  "@@ -1 +1 @@",
  "-old bundle",
  "+new bundle",
].join("\n");

describe("CodeFerret configuration", () => {
  it("returns defaults for an empty document", () => {
    expect(parseCodeFerretConfig("")).toEqual(DEFAULT_CONFIG);
  });

  it("parses supported review controls", () => {
    expect(
      parseCodeFerretConfig(`
version: 1
reviews:
  profile: assertive
  minimum_severity: warning
  auto_review:
    enabled: false
    drafts: true
  ignore: ["dist/**"]
  path_instructions:
    - path: "src/auth/**"
      instructions: "Check token boundaries."
guidelines:
  discover: false
  files: ["docs/review-policy.md"]
reports:
  summary: false
  walkthrough: true
  risk_assessment: false
  linked_issues: true
tools:
  linters: false
  typecheck: true
  security: false
  dependencies: true
  ci_context: false
  timeout_seconds: 45
`),
    ).toEqual({
      profile: "assertive",
      minimumSeverity: "WARNING",
      autoReview: { enabled: false, drafts: true },
      ignore: ["dist/**"],
      pathInstructions: [{ path: "src/auth/**", instructions: "Check token boundaries." }],
      guidelines: { discover: false, files: ["docs/review-policy.md"] },
      reports: { summary: false, walkthrough: true, riskAssessment: false, linkedIssues: true },
      tools: {
        linters: false,
        typecheck: true,
        security: false,
        dependencies: true,
        ciContext: false,
        timeoutSeconds: 45,
      },
    });
  });

  it("rejects unsafe guideline paths and invalid profiles", () => {
    expect(() => parseCodeFerretConfig("reviews:\n  profile: noisy")).toThrow("reviews.profile");
    expect(() => parseCodeFerretConfig("guidelines:\n  files: [\"../secret\"]")).toThrow("unsafe path");
  });
});

describe("configuration enforcement", () => {
  it("matches common repository globs", () => {
    expect(globMatches("src/**", "src/auth/login.ts")).toBe(true);
    expect(globMatches("**/*.test.ts", "src/auth/login.test.ts")).toBe(true);
    expect(globMatches("*.md", "docs/readme.md")).toBe(false);
  });

  it("removes ignored file sections and returns the remaining paths", () => {
    const filtered = filterIgnoredDiff(diff, ["dist/**"]);
    expect(filtered).toContain("src/auth/login.ts");
    expect(filtered).not.toContain("dist/bundle.js");
    expect(changedPaths(filtered)).toEqual(["src/auth/login.ts"]);
  });

  it("selects matching path instructions", () => {
    const config = {
      ...DEFAULT_CONFIG,
      pathInstructions: [
        { path: "src/auth/**", instructions: "Check token boundaries." },
        { path: "migrations/**", instructions: "Check rollback safety." },
      ],
    };
    expect(pathReviewInstructions(config, ["src/auth/login.ts"])).toContain("Check token boundaries.");
    expect(pathReviewInstructions(config, ["src/auth/login.ts"])).not.toContain("rollback");
  });

  it("filters findings below the configured severity", () => {
    const finding = (severity: Finding["severity"]): Finding => ({
      file: "src/app.ts",
      line: 1,
      character: 1,
      severity,
      vector: "LOGIC",
      confidence: "HIGH",
      message: `${severity} issue`,
      explanation: "Concrete failure scenario.",
      patch: null,
    });
    expect(filterFindingsBySeverity([finding("CRITICAL"), finding("WARNING"), finding("SUGGESTION")], "WARNING"))
      .toEqual([finding("CRITICAL"), finding("WARNING")]);
  });
});
