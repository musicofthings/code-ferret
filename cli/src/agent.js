import { spawn, spawnSync } from "node:child_process";

const WIN = process.platform === "win32";

/**
 * The shell is deliberately NEVER used to invoke the host agent, on any
 * platform. cmd.exe re-lexes whatever command line it is handed: it expands
 * `%VAR%` even inside quotes (an information-disclosure path if a prompt or
 * env var leaks into the child's argv), it requires increasingly baroque
 * caret-escaping for `& | ^ < > ( ) ! "`, and — no escaping scheme fixes this
 * one — it truncates the entire command line at the first embedded newline.
 * CodeFerret's real prompts are multi-line by construction, so that last
 * failure mode is not an edge case.
 *
 * The accepted cost: a Windows `.cmd`/`.bat` shim (the kind `npm install -g`
 * creates) cannot be launched directly by `spawn` without a shell, and fails
 * with `EINVAL`. `runAgent` below turns that into an actionable error instead
 * of a bare errno, and `defaultIsInstalled` uses the exact same spawn mode so
 * a shim that can't actually be invoked is never reported as installed. If
 * this needs fixing later (e.g. codex/gemini ship only as npm shims on some
 * user's machine), the fix is a Windows-only fallback that keeps the prompt
 * off the command line entirely (stdin or a temp file) for that shim case —
 * verified against the real CLI's accepted input modes first. Reintroducing
 * `shell: true` is not an option: see the newline failure above.
 */
export const CLAUDE_ALLOWED_TOOLS =
  "Bash(bash:*) Bash(python3:*) Bash(git diff:*) Bash(git log:*) Read Grep Glob Write";

export const AGENTS = [
  {
    name: "claude",
    cmd: "claude",
    args: (prompt) => ["-p", prompt, "--allowedTools", CLAUDE_ALLOWED_TOOLS],
  },
  { name: "codex", cmd: "codex", args: (prompt) => ["exec", prompt] },
  { name: "gemini", cmd: "gemini", args: (prompt) => ["-p", prompt] },
];

/**
 * Mirrors runAgent's spawn mode exactly (shell:false, always). Detection must
 * agree with invocation: a command that runAgent cannot actually launch (a
 * Windows .cmd/.bat shim, which errors with EINVAL without a shell) must not
 * be reported as installed, or `ferret doctor` would say "ok" for an agent
 * every real `ferret review` immediately fails to invoke.
 */
export function defaultIsInstalled(cmd) {
  const probe = spawnSync(cmd, ["--version"], { stdio: "ignore", shell: false });
  return !probe.error;
}

/**
 * Turn a raw spawn failure into a message a user can act on. EINVAL under
 * shell:false on Windows means the target is a .cmd/.bat shim, which this
 * module will never invoke via a shell (see the block comment above) — point
 * the user at the fix instead of surfacing a bare errno.
 */
function describeSpawnFailure(err, agent) {
  if (WIN && err?.code === "EINVAL") {
    return (
      `Could not launch "${agent.cmd}": it looks like a Windows .cmd/.bat shim, ` +
      "which can't be invoked directly (no shell is used here on purpose — a " +
      "shell would corrupt prompts containing quotes, %VAR%, or newlines). " +
      "Point FERRET_AGENT_CMD at the underlying executable instead, for " +
      "example the .exe or .js file the shim wraps."
    );
  }
  return err.message;
}

/** Pick the host agent: explicit override first, then first installed. */
export function detectAgent({ env = process.env, isInstalled = defaultIsInstalled } = {}) {
  const override = env.FERRET_AGENT_CMD || env.FERRET_AGENT;
  if (override) {
    return { name: "custom", cmd: override, args: (prompt) => [prompt] };
  }
  for (const agent of AGENTS) {
    if (isInstalled(agent.cmd)) return agent;
  }
  return null;
}

/**
 * Run the host agent. Its stdout is opaque progress text delivered line by line
 * to onLine; findings are read from .ferret/last-review.json afterwards.
 */
export function runAgent({
  agent,
  prompt,
  cwd,
  onLine,
  env = process.env,
  timeoutMs = 30 * 60 * 1000,
}) {
  return new Promise((resolve) => {
    let child;
    try {
      // No shell, ever — see the block comment above CLAUDE_ALLOWED_TOOLS for why.
      child = spawn(agent.cmd, agent.args(prompt), {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({ exitCode: 1, stderr: describeSpawnFailure(err, agent) });
      return;
    }

    let buffer = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      let index;
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index).replace(/\r$/, "");
        buffer = buffer.slice(index + 1);
        if (line) onLine?.(line);
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (buffer.trim()) onLine?.(buffer.trim());
      resolve({ exitCode: code ?? 1, stderr });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ exitCode: 1, stderr: describeSpawnFailure(err, agent) });
    });
  });
}
