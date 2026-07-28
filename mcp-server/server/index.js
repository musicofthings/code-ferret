#!/usr/bin/env node
/**
 * CodeFerret MCP server (stdio).
 *
 * Exposes CodeFerret's deterministic review machinery (context collection,
 * local analyzers, secret scanning, false-positive cache) as MCP tools, and
 * the review/precommit/triage workflows as MCP prompts. The semantic analysis
 * itself is performed by the host application's model, so CodeFerret works
 * identically with Claude, GPT/Codex, Gemini, Grok, or any other frontier
 * model behind an MCP client.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const MAX_OUTPUT_CHARS = 60_000;
const EXEC_TIMEOUT_MS = 300_000;

/**
 * Locate the CodeFerret scripts/skills, in priority order:
 * 1. CODEFERRET_ROOT env override (the .mcpb bundle sets this to its vendor dir),
 * 2. the repository checkout this server lives in,
 * 3. vendored copies next to the server (fallback for extracted bundles).
 */
function ferretRoot() {
  const override = process.env.CODEFERRET_ROOT;
  if (override && existsSync(join(override, "scripts", "collect-context.sh"))) return override;
  const checkout = resolve(SERVER_DIR, "..", "..");
  if (existsSync(join(checkout, "scripts", "collect-context.sh"))) return checkout;
  return resolve(SERVER_DIR, "..", "vendor");
}

const ROOT = ferretRoot();
const SCRIPTS = join(ROOT, "scripts");
const SKILL_DIR = join(ROOT, "skills", "code-ferret");

/** Import a CLI module by path, Windows-safe. */
function cliModule(name) {
  return import(pathToFileURL(join(ROOT, "cli", "src", name)).href);
}

/**
 * Resolve a caller-supplied repo_path to that repository's .ferret directory,
 * exactly as the CLI does. These tools previously used join(cwd, ".ferret")
 * directly, which is only correct when repo_path happens to be the repository
 * root: pointed at a subdirectory it reported "no reviews" for a repo that had
 * plenty, and pointed anywhere else it silently answered for a .ferret that
 * does not exist. Returns null when the path is not inside a git repository.
 */
async function resolveFerretDir(cwd) {
  const { ferretDir } = await cliModule("paths.js");
  return ferretDir(cwd);
}

function run(command, args, cwd) {
  return new Promise((resolvePromise) => {
    execFile(
      command,
      args,
      { cwd, timeout: EXEC_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolvePromise({
          exitCode: error ? (typeof error.code === "number" ? error.code : 1) : 0,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
        });
      },
    );
  });
}

function clip(text) {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n[... output truncated at ${MAX_OUTPUT_CHARS} characters ...]`;
}

function textResult(text, isError = false) {
  return { content: [{ type: "text", text: clip(text) }], ...(isError ? { isError: true } : {}) };
}

const repoPathArg = z
  .string()
  .optional()
  .describe("Absolute path to the git repository to review (defaults to the server's working directory)");
const targetArg = z
  .enum(["staged", "head"])
  .or(z.string())
  .optional()
  .describe("Diff target: 'staged' (index only), 'head' (working tree vs HEAD, default), or a base ref like 'main'");
// collect-context.sh alone understands 'all' and 'uncommitted' (run_tools.py and
// scan-secrets.sh do not), so only ferret_collect_context gets the wider enum.
const collectTargetArg = z
  .enum(["staged", "head", "all", "uncommitted"])
  .or(z.string())
  .optional()
  .describe(
    "Diff target: 'staged' (index only), 'head' (working tree vs HEAD, default), " +
      "'all' (committed + staged + unstaged vs FERRET_BASE_REF), " +
      "'uncommitted' (staged + unstaged tracked, no untracked), or a base ref like 'main'",
  );

const server = new McpServer({ name: "code-ferret", version: "0.2.0" });

server.registerTool(
  "ferret_collect_context",
  {
    title: "Collect review context",
    description:
      "Emit the scoped diff (±50 lines of lexical context), changed-file list, per-file git history, touched dependency manifests, FERRET_CONFIG (.codeferret.yaml), and repository guidelines for the requested diff target. Run this first for any CodeFerret review.",
    inputSchema: { repo_path: repoPathArg, target: collectTargetArg },
  },
  async ({ repo_path, target }) => {
    const cwd = repo_path || process.cwd();
    const result = await run("bash", [join(SCRIPTS, "collect-context.sh"), target || "head"], cwd);
    if (result.exitCode !== 0) return textResult(result.stderr || result.stdout, true);
    return textResult(result.stdout || "(empty diff)");
  },
);

server.registerTool(
  "ferret_run_analyzers",
  {
    title: "Run installed analyzers",
    description:
      "Run known, already-installed analyzers (ESLint, Ruff, ShellCheck, TypeScript, Semgrep, secret scan, npm/pip audit) against the diff target with bounded time. Never installs anything. Returns normalized, secret-scrubbed JSON results; use them as evidence and deduplicate equivalent semantic findings.",
    inputSchema: { repo_path: repoPathArg, target: targetArg },
  },
  async ({ repo_path, target }) => {
    const cwd = repo_path || process.cwd();
    const result = await run("python3", [join(SCRIPTS, "run_tools.py"), target || "head"], cwd);
    try {
      const results = await readFile(join(cwd, ".ferret", "tool-results.json"), "utf8");
      return textResult(results);
    } catch {
      return textResult(result.stdout || result.stderr || "No analyzer results were produced.", result.exitCode !== 0);
    }
  },
);

server.registerTool(
  "ferret_scan_secrets",
  {
    title: "Scan diff for secrets",
    description:
      "Regex-scan the added lines of the diff target for credentials (GitHub/AWS/Anthropic/OpenAI/Slack tokens, Google API keys, private keys, high-entropy assignments). Returns PASS or the file:line locations of hits — never echo the secret values themselves.",
    inputSchema: { repo_path: repoPathArg, target: targetArg },
  },
  async ({ repo_path, target }) => {
    const cwd = repo_path || process.cwd();
    const result = await run("bash", [join(SCRIPTS, "scan-secrets.sh"), target || "staged"], cwd);
    if (result.exitCode === 0) return textResult("PASS: no credentials detected in the diff.");
    if (result.exitCode === 1) return textResult(`SECRETS FOUND:\n${result.stdout}`);
    return textResult(result.stderr || result.stdout, true);
  },
);

server.registerTool(
  "ferret_fp_cache",
  {
    title: "False-positive suppression cache",
    description:
      "Manage the shared false-positive cache at .ferret/review-cache.json. Actions: 'check' (is this finding suppressed?), 'add' (suppress a pattern a human dismissed), 'list' (dump entries), 'hash' (compute the suppression hash).",
    inputSchema: {
      repo_path: repoPathArg,
      action: z.enum(["check", "add", "list", "hash"]),
      file: z.string().optional().describe("Finding file path (required for check/add/hash)"),
      vector: z.string().optional().describe("Detection vector, e.g. LOGIC or SECURITY"),
      message: z.string().optional().describe("Finding message (required for check/add/hash)"),
      reason: z.string().optional().describe("Why this is a false positive (add only)"),
    },
  },
  async ({ repo_path, action, file, vector, message, reason }) => {
    const cwd = repo_path || process.cwd();
    const args = [join(SCRIPTS, "fp_cache.py"), action];
    if (action !== "list") {
      if (!file || !vector || !message) {
        return textResult("file, vector, and message are required for this action.", true);
      }
      args.push(file, vector, message);
      if (action === "add" && reason) args.push(reason);
    }
    const result = await run("python3", args, cwd);
    if (action === "check") {
      return textResult(result.exitCode === 0 ? "SUPPRESSED: drop this finding silently." : "NOT SUPPRESSED: report normally.");
    }
    if (result.exitCode !== 0) return textResult(result.stderr || result.stdout, true);
    return textResult(result.stdout || "done");
  },
);

server.registerTool(
  "ferret_methodology",
  {
    title: "CodeFerret review methodology",
    description:
      "Return the full CodeFerret review methodology: the five detection vectors (LOGIC, SECURITY, CONCURRENCY, PERFORMANCE, API), confidence calibration, noise reduction, configuration semantics, and the findings output schema. Read before performing a review.",
    inputSchema: {},
  },
  async () => {
    const files = [
      join(SKILL_DIR, "SKILL.md"),
      join(SKILL_DIR, "references", "detection-vectors.md"),
      join(SKILL_DIR, "references", "output-schema.md"),
      join(SKILL_DIR, "references", "configuration.md"),
    ];
    const sections = [];
    for (const file of files) {
      try {
        sections.push(`=== ${file.slice(ROOT.length + 1)} ===\n${await readFile(file, "utf8")}`);
      } catch {
        // reference file not bundled; skip
      }
    }
    return textResult(sections.join("\n\n"));
  },
);

server.registerTool(
  "ferret_doctor",
  {
    title: "Verify CodeFerret setup",
    description:
      "Check the local CodeFerret setup: node runtime, git repository state, .ferret storage, bash/python3, host coding agent, script resolution, and optional analyzers. Failures indicate the review cannot run; warnings are informational.",
    inputSchema: { repo_path: repoPathArg },
  },
  async ({ repo_path }) => {
    try {
      const { runDoctor, formatDoctor } = await cliModule("doctor.js");
      const result = await runDoctor({ cwd: repo_path || process.cwd() });
      return textResult(formatDoctor(result), result.exitCode !== 0);
    } catch (err) {
      return textResult(`Could not load the CodeFerret CLI: ${err.message}`, true);
    }
  },
);

server.registerTool(
  "ferret_stats",
  {
    title: "CodeFerret review statistics",
    description:
      "Aggregate .ferret/history.jsonl into review counts by severity and vector, suppression and dedup totals, and average duration. Set rebuild to recompute the cached stats from scratch.",
    inputSchema: {
      repo_path: repoPathArg,
      rebuild: z.boolean().optional().describe("Rescan review history and rebuild the stats cache"),
    },
  },
  async ({ repo_path, rebuild }) => {
    const cwd = repo_path || process.cwd();
    try {
      const dir = await resolveFerretDir(cwd);
      if (!dir) return textResult(`${cwd} is not inside a git repository.`, true);
      const { readStats, formatStats } = await cliModule("stats.js");
      return textResult(formatStats(await readStats(dir, { rebuild: Boolean(rebuild) })));
    } catch (err) {
      return textResult(`Could not load the CodeFerret CLI: ${err.message}`, true);
    }
  },
);

server.registerTool(
  "ferret_findings",
  {
    title: "Replay stored findings",
    description:
      "Read the findings from the most recent review (.ferret/last-review.json) without re-running analysis. Use in multi-step loops where a later step consumes an earlier review's results.",
    inputSchema: { repo_path: repoPathArg },
  },
  async ({ repo_path }) => {
    const cwd = repo_path || process.cwd();
    try {
      const dir = await resolveFerretDir(cwd);
      if (!dir) return textResult(`${cwd} is not inside a git repository.`, true);
      return textResult(await readFile(join(dir, "last-review.json"), "utf8"));
    } catch {
      return textResult("No stored review found. Run the review prompt first.", true);
    }
  },
);

const REVIEW_PROMPT = (target) => `Run a full CodeFerret semantic review of this repository's diff (target: ${target}).

CodeFerret hunts deep architectural flaws, never style. Follow this workflow exactly:

1. Call the ferret_methodology tool and internalize the five detection vectors, confidence calibration, and output schema.
2. Call ferret_collect_context with target "${target}". If the diff is empty, say so and stop. If it is very large (>15 files), review in directory-grouped batches so no hunk is skipped.
3. Call ferret_run_analyzers with the same target. Treat analyzer findings as evidence; deduplicate equivalent semantic findings instead of reporting them twice.
4. Read each changed file's relevant scope (enclosing functions/classes, call sites of changed signatures). Use the FERRET_FILE_HISTORY section to spot regressions of previously fixed bugs.
5. Analyze every hunk against all five vectors: LOGIC, SECURITY, CONCURRENCY, PERFORMANCE, API. Only report issues caused or exposed by the diff, each with a concrete failure scenario.
6. Filter noise: drop findings a configured linter already enforces; call ferret_fp_cache with action "check" for each remaining finding and drop suppressed ones (count them); assign severity (CRITICAL/WARNING/SUGGESTION) and confidence (HIGH/MEDIUM/LOW) per the methodology.
7. Write the findings JSON to .ferret/last-review.json per the output schema, then print the report: findings ordered CRITICAL → WARNING → SUGGESTION with clickable file:line:col locations, one-line message, failure-scenario explanation, and a ready-to-apply unified diff patch when a safe fix exists. Close with the tally including suppressed and deduped counts.
8. Scrub any credential values from your output as [REDACTED_SECRET] (hardcoded secrets are themselves CRITICAL/SECURITY findings — report location, never value).`;

const PRECOMMIT_PROMPT = `Run a fast CodeFerret pre-commit check of the staged changes. Report ONLY commit blockers: findings that are CRITICAL severity AND HIGH confidence, plus secrets. No WARNINGs, no SUGGESTIONs, speed over depth.

1. Call ferret_scan_secrets with target "staged". Any hit is an automatic blocker — report the file:line, never the value.
2. Call ferret_collect_context with target "staged". If empty, report "nothing staged" and stop.
3. Single fast pass over the hunks for commit-blockers only: hardcoded secrets, injection, unsafe deserialization, guaranteed crashes, and data-corrupting races. Call ferret_fp_cache action "check" before reporting anything.
4. Verdict, first line exactly one of:
   - "FERRET: PASS — safe to commit" (zero blockers)
   - "FERRET: BLOCK — <n> critical issue(s)" followed by findings with file:line locations and one-line fixes.`;

const TRIAGE_PROMPT = (findingsPath) => `Interactively triage CodeFerret findings from ${findingsPath}. If the file does not exist, tell the user to run the review prompt first and stop.

Step through findings one at a time, ordered CRITICAL → WARNING → SUGGESTION, HIGH confidence first. For each, present the severity/vector/confidence header, file:line:character location, message, explanation, and patch (if any), then ask the user to choose:
- Accept & apply patch (when a patch exists) — apply it; if the context drifted, make the equivalent edit manually, then run a cheap compile/parse check.
- Ignore pattern — call ferret_fp_cache with action "add", the finding's file/vector/message, and the user's stated reason, so the pattern is suppressed in future reviews.
- Discuss — explain the concrete failure scenario, the fix's shape, and alternatives, then re-ask.
- Skip — leave the finding open and move on.

Finish with a summary: applied, suppressed, skipped, and stale findings.`;

server.registerPrompt(
  "review",
  {
    title: "CodeFerret full review",
    description: "Diff-scoped semantic review across the five CodeFerret detection vectors.",
    argsSchema: {
      target: z.string().optional().describe("staged | head | <base-branch> (default: head)"),
    },
  },
  ({ target }) => ({
    messages: [{ role: "user", content: { type: "text", text: REVIEW_PROMPT(target || "head") } }],
  }),
);

server.registerPrompt(
  "precommit",
  {
    title: "CodeFerret pre-commit check",
    description: "Fast staged-only check for secrets and CRITICAL/HIGH-confidence blockers.",
    argsSchema: {},
  },
  () => ({
    messages: [{ role: "user", content: { type: "text", text: PRECOMMIT_PROMPT } }],
  }),
);

server.registerPrompt(
  "triage",
  {
    title: "CodeFerret triage",
    description: "Step through saved findings: apply patches, suppress false positives, or discuss.",
    argsSchema: {
      findings_path: z.string().optional().describe("Path to findings JSON (default: .ferret/last-review.json)"),
    },
  },
  ({ findings_path }) => ({
    messages: [
      {
        role: "user",
        content: { type: "text", text: TRIAGE_PROMPT(findings_path || ".ferret/last-review.json") },
      },
    ],
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
