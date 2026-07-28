import { parseArgs } from "node:util";
import { ScopeError } from "./scope.js";
import { runReview } from "./review.js";
import { runDoctor, formatDoctor } from "./doctor.js";
import { readStats, formatStats } from "./stats.js";
import { readReview, readPrompts, sortFindings } from "./findings.js";
import { formatReport } from "./report.js";
import { createEmitter } from "./events.js";
import { ferretDir } from "./paths.js";

export const HELP = `ferret — CodeFerret CLI

Usage:
  ferret [review] [options]      Review the current diff (default command)
  ferret review findings         Replay the last review without re-analyzing
  ferret doctor                  Verify the local setup (exit 1 on failure)
  ferret stats [--rebuild]       Show review statistics from local history

Scope:
  (no flag)                      Committed + staged + unstaged tracked changes
  --committed                    Only committed changes (base...HEAD)
  --uncommitted                  Staged and unstaged edits to tracked files
  --include-untracked            Also include files not added to git
  --base <branch>                Base branch for comparison
  --base-commit <commit>         Base commit for comparison

Options:
  --agent                        Structured JSONL output for coding agents
  --light                        Faster review policy (LOGIC + SECURITY only)
  --show-prompts                 Print saved prompts from the last review
  --dir <path>                   Repository, or a subdirectory to scope to
  -c, --config <file>            Additional instruction file (repeatable)
  --agent-cmd <cmd>              Override host-agent detection
  -h, --help                     Show this help

Environment:
  FERRET_AGENT_CMD               Host agent command override
  FERRET_MAX_FILES               Oversized-diff refusal threshold (default 50)
  CODEFERRET_ROOT                CodeFerret installation root
`;

const OPTIONS = {
  agent: { type: "boolean", default: false },
  light: { type: "boolean", default: false },
  committed: { type: "boolean", default: false },
  uncommitted: { type: "boolean", default: false },
  "include-untracked": { type: "boolean", default: false },
  "show-prompts": { type: "boolean", default: false },
  rebuild: { type: "boolean", default: false },
  base: { type: "string" },
  "base-commit": { type: "string" },
  "agent-cmd": { type: "string" },
  dir: { type: "string" },
  config: { type: "string", short: "c", multiple: true },
  help: { type: "boolean", short: "h", default: false },
};

export function parseFlags(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: OPTIONS,
    allowPositionals: true,
    strict: true,
  });
  const command = positionals[0] ?? "review";
  const sub = positionals[1] ?? null;
  return { command, sub, values };
}

export async function main(argv, io = {}) {
  const {
    stdout = process.stdout,
    stderr = process.stderr,
    env = process.env,
    cwd = process.cwd(),
  } = io;

  let parsed;
  try {
    parsed = parseFlags(argv);
  } catch (err) {
    stderr.write(`error: ${err.message}\n\n${HELP}`);
    return 1;
  }
  const { command, sub, values } = parsed;

  if (values.help) {
    stdout.write(HELP);
    return 0;
  }

  const workdir = values.dir ?? cwd;
  const agentEnv = values["agent-cmd"]
    ? { ...env, FERRET_AGENT_CMD: values["agent-cmd"] }
    : env;

  if (command === "doctor") {
    const result = await runDoctor({ cwd: workdir, env: agentEnv });
    stdout.write(`${formatDoctor(result)}\n`);
    return result.exitCode;
  }

  if (command === "stats") {
    const dir = ferretDir(workdir);
    if (!dir) {
      stderr.write("error: not inside a git repository\n");
      return 1;
    }
    stdout.write(`${formatStats(await readStats(dir, { rebuild: values.rebuild }))}\n`);
    return 0;
  }

  if (command !== "review") {
    stderr.write(`error: unknown command: ${command}\n\n${HELP}`);
    return 1;
  }

  // Every review-mode failure below must reach a --agent consumer as a
  // parseable error event on stdout. Silently writing prose to stderr and
  // exiting 1 leaves an agent parsing an empty JSONL stream with no idea why.
  const fail = (message) => {
    if (values.agent) createEmitter({ agent: true, stdout }).error({ message });
    else stderr.write(`error: ${message}\n`);
    return 1;
  };

  const dir = ferretDir(workdir);
  if (!dir) return fail("not inside a git repository");

  if (sub === "findings") {
    const review = await readReview(dir);
    if (!review) return fail("No stored review found. Run `ferret review` first.");
    const findings = sortFindings(review.findings ?? []);
    const suppressed = review.suppressed ?? 0;
    const deduped = review.deduped ?? 0;
    // `--agent` is a promise about stdout's format, and it has to hold on the
    // replay path too -- this used to print the human report regardless, so
    // `ferret review findings --agent` handed a JSONL consumer prose. Mirrors
    // runReview's success sequence: one event per finding, then complete.
    if (values.agent) {
      const emitter = createEmitter({ agent: true, stdout });
      for (const finding of findings) emitter.finding(finding);
      emitter.complete({
        status: "completed", findings: findings.length, suppressed, deduped,
      });
    } else {
      stdout.write(`${formatReport({ ...review, findings }, { suppressed, deduped })}\n`);
    }
    return 0;
  }

  if (values["show-prompts"]) {
    const prompts = await readPrompts(dir);
    if (!prompts) return fail("No saved prompts found. Run `ferret review` first.");
    const list = prompts.prompts ?? [];
    if (values.agent) {
      createEmitter({ agent: true, stdout }).prompts(list);
    } else {
      for (const prompt of list) {
        stdout.write(`=== ${prompt.name} ===\n${prompt.text}\n\n`);
      }
    }
    return 0;
  }

  const flags = {
    agent: values.agent,
    light: values.light,
    committed: values.committed,
    uncommitted: values.uncommitted,
    includeUntracked: values["include-untracked"],
    base: values.base ?? null,
    baseCommit: values["base-commit"] ?? null,
    config: values.config ?? [],
  };

  try {
    return await runReview({ flags, stdout, stderr, env: agentEnv, cwd: workdir });
  } catch (err) {
    // Scope validation (resolveScope, called from runReview) throws before
    // any agent is spawned. That must still reach a --agent consumer as a
    // parseable error event, not silent stdout plus a bare exit 1.
    if (err instanceof ScopeError) {
      if (values.agent) createEmitter({ agent: true, stdout }).error({ message: err.message });
      else stderr.write(`error: ${err.message}\n`);
      return 1;
    }
    if (values.agent) createEmitter({ agent: true, stdout }).error({ message: err.message });
    else stderr.write(`error: ${err.message}\n`);
    return 1;
  }
}
