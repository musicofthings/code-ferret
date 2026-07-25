import { describe, expect, it } from "vitest";
import {
  calculateConclusion,
  findingFingerprint,
  latestChecksByName,
  parseDiffRightLines,
  parseFindingsText,
  planReview,
  selectNewFindings,
  validateFinding,
  type Finding,
  type ReviewState,
} from "./index";

const validFinding: Finding = {
  file: "src/app.ts",
  line: 12,
  character: 3,
  severity: "WARNING",
  vector: "LOGIC",
  confidence: "HIGH",
  message: "The empty input path throws.",
  explanation: "Calling parse([]) dereferences the missing first element and throws.",
  patch: null,
};

describe("finding validation", () => {
  it("accepts a schema-compliant finding", () => {
    expect(validateFinding(validFinding)).toEqual(validFinding);
  });

  it("rejects unsafe paths and unknown enum values", () => {
    expect(validateFinding({ ...validFinding, file: "../secret.txt" })).toBeNull();
    expect(validateFinding({ ...validFinding, severity: "URGENT" })).toBeNull();
  });

  it("parses fenced JSON and rejects wholly malformed findings", () => {
    expect(parseFindingsText(`\`\`\`json\n${JSON.stringify([validFinding])}\n\`\`\``)).toEqual([
      validFinding,
    ]);
    expect(() => parseFindingsText('[{"message":"missing required fields"}]')).toThrow(
      "no valid findings",
    );
  });

  it("builds stable fingerprints across changing numeric details", () => {
    expect(findingFingerprint({ ...validFinding, message: "Index 12 throws." })).toBe(
      findingFingerprint({ ...validFinding, line: 99, message: "Index 99 throws." }),
    );
  });

  it("suppresses repeated incremental findings but keeps them in full reviews", () => {
    const fingerprint = findingFingerprint(validFinding);
    expect(selectNewFindings("incremental", [validFinding], [fingerprint])).toEqual([]);
    expect(selectNewFindings("full", [validFinding], [fingerprint])).toEqual([validFinding]);
  });

  it("combines code findings and linked requirements into a check conclusion", () => {
    expect(calculateConclusion([], [])).toBe("success");
    expect(calculateConclusion([{ ...validFinding, severity: "WARNING" }], [])).toBe("neutral");
    expect(calculateConclusion([{ ...validFinding, severity: "CRITICAL" }], [])).toBe("failure");
    expect(
      calculateConclusion([], [{ requirement: "Add rollback", status: "NOT_MET", evidence: "No rollback exists." }]),
    ).toBe("failure");
    expect(
      calculateConclusion([], [{ requirement: "Add tests", status: "PARTIAL", evidence: "Only happy path is covered." }]),
    ).toBe("neutral");
  });
});

describe("diff location parsing", () => {
  it("allows right-side context and added lines but not removed lines", () => {
    const diff = [
      "diff --git a/src/app.ts b/src/app.ts",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -10,3 +10,4 @@ function run() {",
      " context",
      "-removed",
      "+added",
      "+another",
      " context-two",
    ].join("\n");

    expect(parseDiffRightLines(diff)).toEqual(
      new Set(["src/app.ts\0" + 10, "src/app.ts\0" + 11, "src/app.ts\0" + 12, "src/app.ts\0" + 13]),
    );
  });
});

describe("incremental review planning", () => {
  const state: ReviewState = {
    lastReviewedSha: "aaa111",
    findingFingerprints: [],
    updatedAt: "2026-07-21T00:00:00.000Z",
  };

  it("uses a full review for a newly opened pull request", () => {
    expect(planReview("opened", "bbb222", state)).toEqual({ mode: "full" });
    expect(planReview("ready_for_review", "bbb222", state)).toEqual({ mode: "full" });
  });

  it("uses the last reviewed SHA for synchronize and reopened events", () => {
    expect(planReview("synchronize", "bbb222", state)).toEqual({
      mode: "incremental",
      baseSha: "aaa111",
    });
    expect(planReview("reopened", "bbb222", state)).toEqual({
      mode: "incremental",
      baseSha: "aaa111",
    });
  });

  it("skips an already reviewed or recently claimed SHA", () => {
    expect(planReview("synchronize", "aaa111", state)).toEqual({
      mode: "skip",
      reason: "already-reviewed",
    });
    expect(
      planReview(
        "synchronize",
        "bbb222",
        { ...state, inProgressSha: "bbb222", inProgressAt: "2026-07-21T00:00:00.000Z" },
        Date.parse("2026-07-21T00:05:00.000Z"),
      ),
    ).toEqual({ mode: "skip", reason: "already-in-progress" });
  });

  it("retries an expired in-progress claim", () => {
    expect(
      planReview(
        "synchronize",
        "bbb222",
        { ...state, inProgressSha: "bbb222", inProgressAt: "2026-07-21T00:00:00.000Z" },
        Date.parse("2026-07-21T00:20:00.000Z"),
      ),
    ).toEqual({ mode: "incremental", baseSha: "aaa111" });
  });

  it("reruns once for a failed CI check on an already reviewed SHA", () => {
    expect(planReview("ci_completed", "aaa111", state, Date.now(), 77)).toEqual({
      mode: "incremental",
      baseSha: "aaa111",
    });
    expect(planReview("ci_completed", "aaa111", { ...state, lastCiCheckId: 77 }, Date.now(), 77)).toEqual({
      mode: "skip",
      reason: "already-reviewed-ci",
    });
  });
});

describe("CI context", () => {
  it("keeps only the latest run for each check name", () => {
    expect(
      latestChecksByName([
        { id: 1, name: "tests", conclusion: "failure", completed_at: "2026-07-21T00:00:00Z" },
        { id: 2, name: "tests", conclusion: "success", completed_at: "2026-07-21T00:05:00Z" },
        { id: 3, name: "lint", conclusion: "failure", completed_at: "2026-07-21T00:02:00Z" },
      ]),
    ).toEqual([
      { id: 2, name: "tests", conclusion: "success", completed_at: "2026-07-21T00:05:00Z" },
      { id: 3, name: "lint", conclusion: "failure", completed_at: "2026-07-21T00:02:00Z" },
    ]);
  });
});
