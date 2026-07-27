import { spawn, spawnSync } from "node:child_process";

const WIN = process.platform === "win32";

/**
 * Permissions the agent needs to run CodeFerret's own scripts non-interactively.
 * Deliberately scoped — never disable permission checks wholesale.
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

function defaultIsInstalled(cmd) {
  const probe = spawnSync(cmd, ["--version"], { stdio: "ignore", shell: WIN });
  return !probe.error;
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
      // No shell, ever: shelling out (even Windows cmd.exe via shell:true) means
      // the prompt's text is re-lexed as command-line syntax before the agent
      // ever sees it. Quoting for that is not just intricate but, for a literal
      // newline, impossible — cmd.exe truncates a `cmd /c "..."` command line at
      // the first embedded newline no matter how it's escaped (verified: caret-
      // escaping the newline does not survive; the second line is silently
      // dropped). Spawning the binary directly sidesteps re-lexing entirely and
      // relies on Node's own well-tested Windows argv marshaling, which we
      // verified round-trips embedded quotes, %VAR%, shell metacharacters, and
      // literal newlines byte-for-byte into the child's argv.
      child = spawn(agent.cmd, agent.args(prompt), {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({ exitCode: 1, stderr: err.message });
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
      resolve({ exitCode: 1, stderr: err.message });
    });
  });
}
