import { existsSync } from "node:fs";
import { access, constants } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { repoRoot, ferretDir, ferretRoot, scriptPath } from "./paths.js";
import { detectAgent, AGENTS, defaultIsInstalled } from "./agent.js";

const ANALYZERS = ["eslint", "ruff", "shellcheck", "tsc", "semgrep"];
const MIN_NODE_MAJOR = 20;

/**
 * Verify the local setup. Failures exit 1; warnings are reported but do not
 * affect the exit code (matching CodeRabbit's `cr doctor`).
 */
export async function runDoctor({
  cwd = process.cwd(),
  env = process.env,
  isInstalled = defaultIsInstalled,
} = {}) {
  const checks = [];
  const add = (name, status, detail) => checks.push({ name, status, detail });

  const major = Number(process.versions.node.split(".")[0]);
  add(
    "node runtime",
    major >= MIN_NODE_MAJOR ? "ok" : "fail",
    `v${process.versions.node} (requires >=${MIN_NODE_MAJOR})`,
  );

  const root = repoRoot(cwd);
  if (root) {
    let branch = "unknown";
    try {
      branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      branch = "unborn branch";
    }
    add("git repository", "ok", `${root} (${branch})`);
  } else {
    add("git repository", "fail", `${cwd} is not inside a git repository`);
  }

  const dir = ferretDir(cwd, root);
  if (!dir) {
    add("ferret storage", "warn", "unavailable outside a git repository");
  } else if (existsSync(dir)) {
    try {
      await access(dir, constants.W_OK);
      add("ferret storage", "ok", dir);
    } catch {
      add("ferret storage", "fail", `${dir} is not writable`);
    }
  } else {
    add("ferret storage", "ok", `${dir} (will be created)`);
  }

  add("bash", isInstalled("bash") ? "ok" : "fail", "required by collect-context.sh");
  add("python3", isInstalled("python3") ? "ok" : "fail", "required by run_tools.py and fp_cache.py");

  // detectAgent throws when FERRET_AGENT_CMD/FERRET_AGENT is set but cannot be
  // spawned (see agent.js) -- that is a deliberate, actionable error for a
  // user-misconfigured override, not a crash. Surface it as a failed check
  // instead of letting it propagate out of runDoctor.
  let agent = null;
  let agentError = null;
  try {
    agent = detectAgent({ env, isInstalled });
  } catch (err) {
    agentError = err;
  }
  if (agent) {
    add("host agent", "ok", `${agent.name} (${agent.cmd})`);
  } else if (agentError) {
    add("host agent", "fail", agentError.message);
  } else {
    add(
      "host agent",
      "fail",
      `none found — install one of: ${AGENTS.map((a) => a.cmd).join(", ")}, ` +
        "or set FERRET_AGENT_CMD",
    );
  }

  const collect = scriptPath("collect-context.sh");
  add(
    "codeferret scripts",
    existsSync(collect) ? "ok" : "fail",
    existsSync(collect) ? ferretRoot() : `not found at ${collect} (set CODEFERRET_ROOT)`,
  );

  const missing = ANALYZERS.filter((a) => !isInstalled(a));
  add(
    "analyzers",
    missing.length === 0 ? "ok" : "warn",
    missing.length === 0 ? ANALYZERS.join(", ") : `not installed: ${missing.join(", ")} (optional)`,
  );

  return { checks, exitCode: checks.some((c) => c.status === "fail") ? 1 : 0 };
}

export function formatDoctor(result) {
  const label = { ok: "OK  ", warn: "WARN", fail: "FAIL" };
  const lines = result.checks.map(
    (c) => `${label[c.status]}  ${c.name.padEnd(20)} ${c.detail}`,
  );
  const failed = result.checks.filter((c) => c.status === "fail").length;
  const warned = result.checks.filter((c) => c.status === "warn").length;
  lines.push("");
  lines.push(
    failed === 0
      ? `All checks passed${warned ? ` (${warned} warning${warned > 1 ? "s" : ""})` : ""}.`
      : `${failed} check${failed > 1 ? "s" : ""} failed.`,
  );
  return lines.join("\n");
}
