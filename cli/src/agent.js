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
  // timeout: a wedged `claude --version` (or any hung probe) would otherwise
  // block `ferret doctor` forever with no escape. spawnSync sets `.error` on
  // a timeout, so the existing `!probe.error` check already handles it.
  const probe = spawnSync(cmd, ["--version"], { stdio: "ignore", shell: false, timeout: 5000 });
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

/**
 * Parse a FERRET_AGENT_CMD/FERRET_AGENT override into { cmd, extra }.
 *
 * shell:false means the override can only ever name ONE literal executable
 * -- there is no lexer here to split "node wrapper.js" or "claude --model
 * opus" into a program plus arguments, and there deliberately never will be
 * (see the block comment above CLAUDE_ALLOWED_TOOLS: a lexer is exactly what
 * introducing a shell would smuggle back in). A bare value is always taken
 * as that one executable, unchanged from the original behavior -- this is
 * also why whitespace-splitting was rejected as the fix: the single most
 * common real value on Windows, `C:\Program Files\nodejs\node.exe`, is
 * itself a path containing a space, and splitting on whitespace would break
 * that working case to fix the broken one.
 *
 * A value whose first non-whitespace character is `[` is instead parsed as
 * a literal JSON argv array -- unambiguous, no quoting rules to get wrong,
 * and it keeps argv[0] (probed by isInstalled) and the trailing arguments
 * fully separate from the prompt, which is always appended last and never
 * concatenated into anything that gets re-parsed.
 */
function parseAgentOverride(override) {
  if (!override.trimStart().startsWith("[")) {
    return { cmd: override, extra: [] };
  }
  let argv;
  try {
    argv = JSON.parse(override);
  } catch (err) {
    throw new Error(
      `FERRET_AGENT_CMD/FERRET_AGENT looks like a JSON array (starts with "[") ` +
        `but failed to parse: ${err.message}. Use a JSON array of strings, e.g. ` +
        `'["C:\\\\path\\\\to\\\\node.exe", "wrapper.js"]'.`,
    );
  }
  if (!Array.isArray(argv) || argv.length === 0 || argv.some((v) => typeof v !== "string")) {
    throw new Error(
      "FERRET_AGENT_CMD/FERRET_AGENT is a JSON value but not a non-empty array " +
        'of strings, e.g. \'["C:\\\\path\\\\to\\\\node.exe", "wrapper.js"]\'.',
    );
  }
  const [cmd, ...extra] = argv;
  return { cmd, extra };
}

/**
 * Pick the host agent: explicit override first, then first installed.
 *
 * The override is run through the same isInstalled probe as the built-ins —
 * it does not get to exempt itself from the "an agent runAgent cannot spawn
 * must not be reported as installed" guarantee. If the override fails the
 * probe, this throws (rather than silently falling through to auto-detection
 * or returning null) because the user configured it explicitly: they deserve
 * to be told that specific command cannot be spawned, not a generic "no
 * agent found" that looks identical to never having configured one at all.
 */
export function detectAgent({ env = process.env, isInstalled = defaultIsInstalled } = {}) {
  const override = env.FERRET_AGENT_CMD || env.FERRET_AGENT;
  if (override) {
    const { cmd, extra } = parseAgentOverride(override);
    if (!isInstalled(cmd)) {
      throw new Error(
        `FERRET_AGENT_CMD/FERRET_AGENT is set to "${override}", but it can't be ` +
          "spawned (it may be a Windows .cmd/.bat shim, not on PATH, or not " +
          "executable). Point it at a directly executable binary, or unset it " +
          "to fall back to auto-detecting claude/codex/gemini. If you need to " +
          "pass arguments (e.g. a wrapper script, or \"claude --model opus\"), " +
          'use a JSON array instead: \'["cmd", "arg1", "arg2"]\' -- a plain ' +
          '"cmd arg1 arg2" string can never be spawned here, since no shell ' +
          "is used to split it.",
      );
    }
    return { name: "custom", cmd, args: (prompt) => [...extra, prompt] };
  }
  for (const agent of AGENTS) {
    if (isInstalled(agent.cmd)) return agent;
  }
  return null;
}

const KILL_GRACE_MS = 5000;

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

    // Decode at the stream level so Node's internal StringDecoder holds a
    // partial multibyte sequence across a chunk boundary. Manually calling
    // .toString() on a raw Buffer that ends mid-sequence emits U+FFFD
    // replacement characters instead -- agent progress output is full of
    // box-drawing and spinner glyphs, so this is not a hypothetical.
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    let settled = false;
    let buffer = "";
    let stderr = "";
    let timedOut = false;
    let killTimer = null;

    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index).replace(/\r$/, "");
        buffer = buffer.slice(index + 1);
        if (line && !settled) onLine?.(line);
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });

    // A timeout is otherwise indistinguishable from any other failure (both
    // would resolve {exitCode:1, stderr:""}). SIGTERM alone is not enough to
    // guarantee this promise ever settles: on Windows it maps to
    // TerminateProcess and always works, but on POSIX a child that traps or
    // ignores SIGTERM never emits 'close', and the promise would hang
    // forever -- breaking the "runAgent always resolves" guarantee. The
    // grace timer's SIGKILL cannot be caught or ignored by the child.
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
    }, timeoutMs);

    function finish(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      resolve(result);
    }

    child.on("close", (code) => {
      if (!settled && buffer.trim()) onLine?.(buffer.trim());
      const note = timedOut
        ? `Agent timed out after ${timeoutMs}ms and was sent SIGTERM.`
        : null;
      finish({
        exitCode: code ?? 1,
        stderr: note ? (stderr ? `${stderr}\n${note}` : note) : stderr,
        timedOut,
      });
    });
    child.on("error", (err) => {
      finish({ exitCode: 1, stderr: describeSpawnFailure(err, agent), timedOut });
    });
  });
}
