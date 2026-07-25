import { parse } from "yaml";
import type { Finding } from "./index";

export type ReviewProfile = "chill" | "balanced" | "assertive";
export type MinimumSeverity = "CRITICAL" | "WARNING" | "SUGGESTION";

export interface PathInstruction {
  path: string;
  instructions: string;
}

export interface CodeFerretConfig {
  profile: ReviewProfile;
  minimumSeverity: MinimumSeverity;
  autoReview: {
    enabled: boolean;
    drafts: boolean;
  };
  ignore: string[];
  pathInstructions: PathInstruction[];
  guidelines: {
    discover: boolean;
    files: string[];
  };
  reports: {
    summary: boolean;
    walkthrough: boolean;
    riskAssessment: boolean;
    linkedIssues: boolean;
  };
  tools: {
    linters: boolean;
    typecheck: boolean;
    security: boolean;
    dependencies: boolean;
    ciContext: boolean;
    timeoutSeconds: number;
  };
}

export const DEFAULT_CONFIG: CodeFerretConfig = {
  profile: "balanced",
  minimumSeverity: "SUGGESTION",
  autoReview: { enabled: true, drafts: false },
  ignore: [],
  pathInstructions: [],
  guidelines: {
    discover: true,
    files: ["AGENTS.md", "CLAUDE.md", ".cursorrules"],
  },
  reports: {
    summary: true,
    walkthrough: true,
    riskAssessment: true,
    linkedIssues: true,
  },
  tools: {
    linters: true,
    typecheck: true,
    security: true,
    dependencies: true,
    ciContext: true,
    timeoutSeconds: 120,
  },
};

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a mapping`);
  return value as Record<string, unknown>;
}

function optionalBoolean(value: unknown, fallback: boolean, label: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`${label} must be true or false`);
  return value;
}

function safeRepoPath(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 1024 &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    !value.split("/").includes("..")
  );
}

function stringList(value: unknown, fallback: string[], label: string, maximum: number): string[] {
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value) || value.length > maximum || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} must be a list of at most ${maximum} strings`);
  }
  return value as string[];
}

export function parseCodeFerretConfig(source: string): CodeFerretConfig {
  const root = asRecord(parse(source), ".codeferret.yaml");
  if (root.version !== undefined && root.version !== 1) throw new Error("version must be 1");
  const reviews = asRecord(root.reviews, "reviews");
  const autoReview = asRecord(reviews.auto_review, "reviews.auto_review");
  const guidelines = asRecord(root.guidelines, "guidelines");
  const reports = asRecord(root.reports, "reports");
  const tools = asRecord(root.tools, "tools");

  const profile = reviews.profile ?? DEFAULT_CONFIG.profile;
  if (!(["chill", "balanced", "assertive"] as unknown[]).includes(profile)) {
    throw new Error("reviews.profile must be chill, balanced, or assertive");
  }

  const severityValue = String(reviews.minimum_severity ?? DEFAULT_CONFIG.minimumSeverity).toUpperCase();
  if (!(["CRITICAL", "WARNING", "SUGGESTION"] as string[]).includes(severityValue)) {
    throw new Error("reviews.minimum_severity must be critical, warning, or suggestion");
  }

  const rawInstructions = reviews.path_instructions ?? [];
  if (!Array.isArray(rawInstructions) || rawInstructions.length > 50) {
    throw new Error("reviews.path_instructions must be a list of at most 50 entries");
  }
  const pathInstructions = rawInstructions.map((entry, index) => {
    const item = asRecord(entry, `reviews.path_instructions[${index}]`);
    if (typeof item.path !== "string" || !safeRepoPath(item.path) || item.path.length > 200) {
      throw new Error(`reviews.path_instructions[${index}].path is invalid`);
    }
    if (
      typeof item.instructions !== "string" ||
      item.instructions.length === 0 ||
      item.instructions.length > 2000
    ) {
      throw new Error(`reviews.path_instructions[${index}].instructions is invalid`);
    }
    return { path: item.path, instructions: item.instructions };
  });

  const ignore = stringList(reviews.ignore, DEFAULT_CONFIG.ignore, "reviews.ignore", 100);
  if (
    ignore.some(
      (pattern) =>
        pattern.length === 0 ||
        pattern.length > 200 ||
        pattern.startsWith("/") ||
        pattern.includes("\\") ||
        pattern.includes("\0"),
    )
  ) {
    throw new Error("reviews.ignore contains an invalid pattern");
  }

  const guidelineFiles = stringList(
    guidelines.files,
    DEFAULT_CONFIG.guidelines.files,
    "guidelines.files",
    20,
  );
  if (guidelineFiles.some((file) => !safeRepoPath(file))) {
    throw new Error("guidelines.files contains an unsafe path");
  }

  const timeoutSeconds = tools.timeout_seconds ?? DEFAULT_CONFIG.tools.timeoutSeconds;
  if (!Number.isInteger(timeoutSeconds) || (timeoutSeconds as number) < 10 || (timeoutSeconds as number) > 600) {
    throw new Error("tools.timeout_seconds must be an integer between 10 and 600");
  }

  return {
    profile: profile as ReviewProfile,
    minimumSeverity: severityValue as MinimumSeverity,
    autoReview: {
      enabled: optionalBoolean(autoReview.enabled, DEFAULT_CONFIG.autoReview.enabled, "reviews.auto_review.enabled"),
      drafts: optionalBoolean(autoReview.drafts, DEFAULT_CONFIG.autoReview.drafts, "reviews.auto_review.drafts"),
    },
    ignore,
    pathInstructions,
    guidelines: {
      discover: optionalBoolean(guidelines.discover, DEFAULT_CONFIG.guidelines.discover, "guidelines.discover"),
      files: guidelineFiles,
    },
    reports: {
      summary: optionalBoolean(reports.summary, DEFAULT_CONFIG.reports.summary, "reports.summary"),
      walkthrough: optionalBoolean(
        reports.walkthrough,
        DEFAULT_CONFIG.reports.walkthrough,
        "reports.walkthrough",
      ),
      riskAssessment: optionalBoolean(
        reports.risk_assessment,
        DEFAULT_CONFIG.reports.riskAssessment,
        "reports.risk_assessment",
      ),
      linkedIssues: optionalBoolean(
        reports.linked_issues,
        DEFAULT_CONFIG.reports.linkedIssues,
        "reports.linked_issues",
      ),
    },
    tools: {
      linters: optionalBoolean(tools.linters, DEFAULT_CONFIG.tools.linters, "tools.linters"),
      typecheck: optionalBoolean(tools.typecheck, DEFAULT_CONFIG.tools.typecheck, "tools.typecheck"),
      security: optionalBoolean(tools.security, DEFAULT_CONFIG.tools.security, "tools.security"),
      dependencies: optionalBoolean(
        tools.dependencies,
        DEFAULT_CONFIG.tools.dependencies,
        "tools.dependencies",
      ),
      ciContext: optionalBoolean(tools.ci_context, DEFAULT_CONFIG.tools.ciContext, "tools.ci_context"),
      timeoutSeconds: timeoutSeconds as number,
    },
  };
}

export function globMatches(pattern: string, path: string): boolean {
  let regex = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*" && pattern[index + 1] === "*") {
      if (pattern[index + 2] === "/") {
        regex += "(?:.*/)?";
        index += 2;
      } else {
        regex += ".*";
        index += 1;
      }
    } else if (character === "*") {
      regex += "[^/]*";
    } else if (character === "?") {
      regex += "[^/]";
    } else {
      regex += character.replace(/[|\\{}()[\]^$+?.-]/g, "\\$&");
    }
  }
  return new RegExp(`${regex}$`).test(path);
}

function sectionPath(section: string): string | null {
  const added = section.match(/^\+\+\+ (.+)$/m)?.[1];
  const removed = section.match(/^--- (.+)$/m)?.[1];
  const raw = added && added !== "/dev/null" ? added : removed;
  if (!raw || raw === "/dev/null" || raw.startsWith('"')) return null;
  return raw.startsWith("a/") || raw.startsWith("b/") ? raw.slice(2) : raw;
}

export function filterIgnoredDiff(diff: string, patterns: string[]): string {
  if (patterns.length === 0) return diff;
  return diff
    .split(/(?=^diff --git )/m)
    .filter((section) => {
      const path = sectionPath(section);
      return !path || !patterns.some((pattern) => globMatches(pattern, path));
    })
    .join("");
}

export function changedPaths(diff: string): string[] {
  return Array.from(
    new Set(
      diff
        .split(/(?=^diff --git )/m)
        .map(sectionPath)
        .filter((path): path is string => path !== null),
    ),
  );
}

export function pathReviewInstructions(config: CodeFerretConfig, paths: string[]): string {
  const applicable = config.pathInstructions.filter((rule) => paths.some((path) => globMatches(rule.path, path)));
  if (applicable.length === 0) return "";
  return [
    "Repository path-specific review instructions:",
    ...applicable.map((rule) => `- ${rule.path}: ${rule.instructions}`),
  ].join("\n");
}

export function filterFindingsBySeverity(findings: Finding[], minimum: MinimumSeverity): Finding[] {
  const rank: Record<MinimumSeverity, number> = { CRITICAL: 0, WARNING: 1, SUGGESTION: 2 };
  return findings.filter((finding) => rank[finding.severity] <= rank[minimum]);
}
