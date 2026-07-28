import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { join, relative, resolve, isAbsolute, sep } from "node:path";
import { repoRoot, ferretDir, scriptPath } from "./paths.js";
import { resolveScope } from "./scope.js";
import { detectAgent, runAgent } from "./agent.js";
import { createEmitter, emitNoChanges } from "./events.js";
import { readReview, sortFindings } from "./findings.js";
import { formatReport, formatCandidates } from "./report.js";
import { computeCandidates } from "./candidates.js";
import { appendHistory } from "./stats.js";

const execFileAsync = promisify(execFile);
const DEFAULT_MAX_FILES = 50;
const HEARTBEAT_MS = 15_000;

/** Best-effort default base branch: origin/HEAD, else main, else master. */
async function defaultBase(cwd) {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
      { cwd },
    );
    const ref = stdout.trim().replace(/^origin\//, "");
    if (ref) return ref;
  } catch { /* no origin/HEAD; fall through */ }
  for (const ref of ["main", "master"]) {
    try {
      await execFileAsync("git", ["rev-parse", "--verify", `${ref}^{commit}`], { cwd });
      return ref;
    } catch { /* try next */ }
  }
  return "main";
}

async function gitFiles(cwd, args) {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 32 * 1024 * 1024 });
    return stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Files in scope, used for the empty-diff check and candidate computation.
 * `pathspec`, when set, narrows every git call to that subtree (see the
 * `--dir` handling in runReview) -- without it, `--dir` only changed which
 * directory git ran from, not what it reported, since repoRoot() always
 * resolves back to the toplevel.
 */
async function scopeFiles(cwd, scope, pathspec) {
  const spec = pathspec ? ["--", pathspec] : [];
  if (scope.target === "uncommitted") {
    const tracked = await gitFiles(cwd, ["diff", "HEAD", "--name-only", ...spec]);
    if (!scope.includeUntracked) return tracked;
    return [
      ...tracked,
      ...(await gitFiles(cwd, ["ls-files", "--others", "--exclude-standard", ...spec])),
    ];
  }
  if (scope.target === "all") {
    const changed = await gitFiles(cwd, ["diff", scope.baseRef, "--name-only", ...spec]);
    if (!scope.includeUntracked) return changed;
    return [
      ...changed,
      ...(await gitFiles(cwd, ["ls-files", "--others", "--exclude-standard", ...spec])),
    ];
  }
  return gitFiles(cwd, ["diff", `${scope.target}...HEAD`, "--name-only", ...spec]);
}

/**
 * The directory requested via `--dir`, expressed as a git pathspec relative
 * to the repo root, or null when it IS the repo root (no narrowing needed).
 * Guards against a cross-drive `relative()` result on Windows, which would
 * come back as an absolute path rather than a real subtree.
 */
function scopePathspec(root, cwd) {
  const rel = relative(root, resolve(cwd));
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.split(sep).join("/");
}

function buildPrompt({ target, light, configFiles }) {
  const vectors = light
    ? "LOGIC and SECURITY only (light policy)"
    : "LOGIC, SECURITY, CONCURRENCY, PERFORMANCE, API";
  const analyzers = light
    ? "Skip the analyzer step entirely (light policy)."
    : `Run \`python3 ${scriptPath("run_tools.py")} ${target}\` and read .ferret/tool-results.json. `
      + "Treat analyzer findings as evidence and deduplicate equivalent semantic findings.";
  const extra = configFiles.length
    ? `Additional instruction files to honor: ${configFiles.join(", ")}.\n`
    : "";
  return `Run a CodeFerret semantic review of this repository (target: ${target}).

Load the code-ferret skill and follow its methodology exactly.
${extra}
1. Collect context: \`bash ${scriptPath("collect-context.sh")} ${target}\`
   The environment already carries FERRET_BASE_REF, FERRET_INCLUDE_UNTRACKED
   and FERRET_LIGHT — do not override them.
2. ${analyzers}
3. Read each changed file's enclosing scope and call sites of changed signatures.
4. Analyze every hunk against these vectors: ${vectors}.
   Report only issues caused or exposed by the diff, each with a concrete
   failure scenario.
5. Filter noise: drop findings a configured linter already enforces; run
   \`python3 ${scriptPath("fp_cache.py")} check <file> <vector> "<message>"\`
   for each remaining finding and drop suppressed ones, counting them.
6. Write findings JSON to .ferret/last-review.json per the skill's output
   schema. Include a codegen_instructions field on every finding: imperative
   fix instructions aimed at a coding agent, or null when no mechanical fix
   exists. Also write .ferret/last-prompts.json as
   {"generated_at": <iso>, "target": "${target}", "prompts": [{"name": "review", "text": <this prompt>}]}.
7. Scrub any credential values as [REDACTED_SECRET]. Report secret locations,
   never values.

Do not print a report — the CLI renders one from the JSON you write.`;
}

export async function runReview({ flags, stdout, stderr, env, cwd }) {
  const root = repoRoot(cwd);
  if (!root) {
    stderr.write("error: not inside a git repository\n");
    return 1;
  }
  const dir = ferretDir(cwd);
  const scope = resolveScope(flags, { defaultBase: await defaultBase(root) });
  const emitter = createEmitter({ agent: flags.agent, stdout });

  let branch = "unknown";
  try {
    const { stdout: out } = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root });
    branch = out.trim();
  } catch { /* unborn branch */ }

  const pathspec = scopePathspec(root, cwd);
  const files = await scopeFiles(root, scope, pathspec);

  // detectAgent throws when FERRET_AGENT_CMD/FERRET_AGENT is set but cannot be
  // spawned (see agent.js) -- that is a deliberate, actionable error for a
  // user-misconfigured override, not a crash. Surface it as a review failure
  // instead of letting it propagate out of runReview.
  let agent = null;
  let agentError = null;
  try {
    agent = detectAgent({ env });
  } catch (err) {
    agentError = err;
  }

  const context = {
    target: scope.target,
    branch,
    baseRef: scope.baseRef,
    files: files.length,
    agent: agent?.name ?? null,
    light: Boolean(flags.light),
  };

  if (files.length === 0) {
    if (flags.agent) emitNoChanges(emitter, context);
    else stdout.write("No changes detected in the selected scope.\n");
    return 0;
  }

  // Number(...) turns junk into NaN, and `files.length > NaN` is always
  // false -- that would silently disable the oversized-diff budget guard
  // instead of falling back to the documented default. parseInt + an
  // explicit sanity check ensures garbage (or "") always falls back, never
  // disables the check.
  const rawMaxFiles = Number.parseInt(env.FERRET_MAX_FILES ?? "", 10);
  const maxFiles = Number.isInteger(rawMaxFiles) && rawMaxFiles > 0 ? rawMaxFiles : DEFAULT_MAX_FILES;
  if (files.length > maxFiles) {
    const { candidates, candidatesNote } = computeCandidates({
      files,
      maxFiles,
      committedFiles: await gitFiles(root, ["diff", `${scope.baseRef}...HEAD`, "--name-only"]),
      uncommittedFiles: await gitFiles(root, ["diff", "HEAD", "--name-only"]),
    });
    const message = `Review scope too large: ${files.length} files (limit ${maxFiles})`;
    if (flags.agent) emitter.error({ message, candidates, candidatesNote });
    else stderr.write(`error: ${message}\n\n${formatCandidates(candidates, candidatesNote)}\n`);
    return 1;
  }

  if (!agent) {
    const message = agentError
      ? agentError.message
      : "No host coding agent found. Install claude, codex, or gemini, or set FERRET_AGENT_CMD. Run `ferret doctor` for details.";
    if (flags.agent) emitter.error({ message });
    else stderr.write(`error: ${message}\n`);
    return 1;
  }

  emitter.reviewContext(context);
  emitter.status("collecting_context");

  const agentEnv = {
    ...env,
    FERRET_BASE_REF: scope.baseRef ?? "main",
    FERRET_INCLUDE_UNTRACKED: scope.includeUntracked ? "1" : "0",
    FERRET_LIGHT: flags.light ? "1" : "0",
  };
  const prompt = buildPrompt({
    target: scope.target,
    light: Boolean(flags.light),
    configFiles: flags.config ?? [],
  });

  // A stale last-review.json from a previous run must not survive into this
  // one: without this, an agent that fails outright (non-zero exit, wrote
  // nothing) or times out leaves the old file in place, `readReview` happily
  // returns it, `!review` is false, and both failure branches below become
  // unreachable -- the CLI reports the previous run's findings as fresh,
  // appends them to permanent history, and exits 0.
  await rm(join(dir, "last-review.json"), { force: true });
  await rm(join(dir, "last-prompts.json"), { force: true });

  const started = Date.now();
  const beat = setInterval(() => emitter.heartbeat(), HEARTBEAT_MS);
  emitter.status("reviewing");
  if (!flags.agent) stdout.write(`Reviewing ${files.length} file(s) with ${agent.name}…\n`);

  const result = await runAgent({
    agent,
    prompt,
    cwd: root,
    env: agentEnv,
    onLine: (line) => {
      if (!flags.agent) stdout.write(`  ${line}\n`);
    },
  });
  clearInterval(beat);

  const review = await readReview(dir);
  if (result.exitCode !== 0 && !review) {
    const message = `Host agent ${agent.name} failed (exit ${result.exitCode}). ${result.stderr.trim()}`;
    if (flags.agent) emitter.error({ message });
    else stderr.write(`error: ${message}\n`);
    return 1;
  }
  if (!review) {
    const message = "The host agent did not write .ferret/last-review.json.";
    if (flags.agent) emitter.error({ message });
    else stderr.write(`error: ${message}\n`);
    return 1;
  }

  const findings = sortFindings(review.findings ?? []);
  const tally = { suppressed: review.suppressed ?? 0, deduped: review.deduped ?? 0 };

  if (flags.agent) {
    for (const finding of findings) emitter.finding(finding);
    emitter.complete({
      status: "completed",
      findings: findings.length,
      suppressed: tally.suppressed,
      deduped: tally.deduped,
    });
  } else {
    stdout.write(`\n${formatReport({ ...review, findings }, tally)}\n`);
  }

  await mkdir(dir, { recursive: true });
  // Severity/vector strings come straight from LLM-authored JSON, so treat
  // them as untrusted: normalize case (agent.js's own wire mapping already
  // uppercases, so a lowercase "critical" must still count), and gate the
  // increment on Object.hasOwn against a known key set rather than an
  // `!== undefined` check, which is both case-sensitive and reachable via
  // Object.prototype (a finding with severity: "constructor" would otherwise
  // write a corrupted own "constructor" property that stats.js's aggregate()
  // then string-concatenates into findings_total -- permanent, unrecoverable
  // stats corruption from a single bad line).
  const bySeverity = { CRITICAL: 0, WARNING: 0, SUGGESTION: 0 };
  const byVector = Object.create(null);
  for (const f of findings) {
    const sev = String(f.severity ?? "").toUpperCase();
    if (Object.hasOwn(bySeverity, sev)) bySeverity[sev] += 1;
    const vec = f.vector ? String(f.vector).toUpperCase() : null;
    if (vec) byVector[vec] = (byVector[vec] ?? 0) + 1;
  }
  await appendHistory(dir, {
    ts: new Date().toISOString(),
    target: scope.target,
    branch,
    commit: (await gitFiles(root, ["rev-parse", "--short", "HEAD"]))[0] ?? null,
    by_severity: bySeverity,
    by_vector: byVector,
    suppressed: tally.suppressed,
    deduped: tally.deduped,
    duration_ms: Date.now() - started,
    agent: agent.name,
    light: Boolean(flags.light),
  });
  // Invalidate the derived stats cache so the next `ferret stats` recomputes.
  // Must DELETE, not overwrite with `{}`: readStats parses any valid JSON it
  // finds and returns it as-is, so an empty object would make `ferret stats`
  // report `undefined` reviews forever.
  await rm(join(dir, "stats.json"), { force: true });

  return 0;
}
