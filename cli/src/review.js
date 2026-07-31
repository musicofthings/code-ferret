import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { join, relative, resolve, isAbsolute, sep } from "node:path";
import { repoRoot, ferretDir, scriptPath } from "./paths.js";
import { resolveScope } from "./scope.js";
import { detectAgent, runAgent } from "./agent.js";
import { createEmitter, emitNoChanges } from "./events.js";
import { readReview, sortFindings, tallySeverities } from "./findings.js";
import { formatReport, formatCandidates } from "./report.js";
import { computeCandidates } from "./candidates.js";
import { appendHistory } from "./stats.js";
import { acquireReviewLock, LockBusyError } from "./lock.js";

const execFileAsync = promisify(execFile);
const DEFAULT_MAX_FILES = 50;
const HEARTBEAT_MS = 15_000;

/** True when `ref` resolves to a commit in this repository. */
async function refExists(cwd, ref) {
  try {
    await execFileAsync("git", ["rev-parse", "--verify", `${ref}^{commit}`], { cwd });
    return true;
  } catch {
    return false;
  }
}

/**
 * Best-effort default base branch: origin/HEAD, else main, else master.
 *
 * Returns null -- never a speculative fallback -- when none of those resolve.
 * A previous version ended with a bare `return "main"`, so a repository whose
 * default branch is neither main nor master (and has no origin/HEAD) silently
 * reviewed against a ref that does not exist: every git call below failed,
 * which used to be indistinguishable from an empty diff, and a plain `ferret
 * review` reported "No changes detected" and exited 0 on a repo full of real
 * changes. Callers must treat null as "ask the user for --base".
 */
async function defaultBase(cwd) {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
      { cwd },
    );
    // The local branch of the same name is what gets diffed, and it is not
    // guaranteed to exist just because the remote HEAD points at it (a fetch
    // without a checkout leaves only the remote-tracking ref). Verify before
    // returning it, and fall through to main/master when it is missing.
    const ref = stdout.trim().replace(/^origin\//, "");
    if (ref && (await refExists(cwd, ref))) return ref;
  } catch { /* no origin/HEAD; fall through */ }
  for (const ref of ["main", "master"]) {
    if (await refExists(cwd, ref)) return ref;
  }
  return null;
}

/**
 * Changed-file list from git, or null when git itself failed.
 *
 * The null/[] distinction is load-bearing. An empty array means "the diff is
 * genuinely empty", which makes runReview print "No changes detected" and exit
 * 0. This function used to return [] on failure too, so an unresolvable base
 * ref or an unborn HEAD produced the exact same clean-pass result as a clean
 * tree -- `ferret review --base typo` exited 0 and, under --agent, emitted a
 * review_skipped/complete pair. Every caller must turn null into a hard error;
 * an empty diff is the only thing allowed to exit 0.
 */
async function gitFiles(cwd, args) {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 32 * 1024 * 1024 });
    return stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  } catch {
    return null;
  }
}

/**
 * `gitFiles`, narrowed to `pathspec` (the `--dir` subtree) when one is given.
 * This is the ONE place the `["--", pathspec]` suffix is built -- every git
 * call that must respect `--dir` (scope resolution AND the oversized-diff
 * candidate counts) goes through this, so `--dir` can't quietly stop
 * applying to a call added later.
 */
async function scopedGitFiles(cwd, args, pathspec) {
  return gitFiles(cwd, pathspec ? [...args, "--", pathspec] : args);
}

/** Concatenate two gitFiles results, propagating a null from either side. */
function concatFiles(a, b) {
  return a === null || b === null ? null : [...a, ...b];
}

/**
 * Files in scope, used for the empty-diff check and candidate computation.
 * `pathspec`, when set, narrows every git call to that subtree (see the
 * `--dir` handling in runReview) -- without it, `--dir` only changed which
 * directory git ran from, not what it reported, since repoRoot() always
 * resolves back to the toplevel.
 *
 * Returns null when any underlying git call failed (see gitFiles): the caller
 * must not treat that as an empty diff.
 */
async function scopeFiles(cwd, scope, pathspec) {
  const untracked = () =>
    scopedGitFiles(cwd, ["ls-files", "--others", "--exclude-standard"], pathspec);

  if (scope.target === "uncommitted") {
    const tracked = await scopedGitFiles(cwd, ["diff", "HEAD", "--name-only"], pathspec);
    if (tracked === null || !scope.includeUntracked) return tracked;
    return concatFiles(tracked, await untracked());
  }
  if (scope.target === "all") {
    const changed = await scopedGitFiles(cwd, ["diff", scope.baseRef, "--name-only"], pathspec);
    if (changed === null || !scope.includeUntracked) return changed;
    return concatFiles(changed, await untracked());
  }
  return scopedGitFiles(cwd, ["diff", `${scope.target}...HEAD`, "--name-only"], pathspec);
}

/**
 * Resolve symlinks (and macOS /var → /private/var) so relative() against
 * git's --show-toplevel result does not spuriously climb out of the tree.
 */
function realPath(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * The directory requested via `--dir`, expressed as a git pathspec relative
 * to the repo root, or null when it IS the repo root (no narrowing needed).
 * Guards against a cross-drive `relative()` result on Windows, which would
 * come back as an absolute path rather than a real subtree.
 *
 * Both sides are realpath'd: on macOS, `git rev-parse --show-toplevel` returns
 * `/private/var/...` while Node temp paths are often `/var/...` (a symlink).
 * Without normalizing, relative() climbs out with `../..` and --dir is
 * silently dropped — the whole-repo file count is used instead.
 */
function scopePathspec(root, cwd) {
  const rel = relative(realPath(root), realPath(cwd));
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.split(sep).join("/");
}

function buildPrompt({ target, light, configFiles }) {
  const vectors = light
    ? "LOGIC and SECURITY only (light policy)"
    : "LOGIC, SECURITY, CONCURRENCY, PERFORMANCE, API";
  // run_tools.py predates the "all"/"uncommitted" targets and only understands
  // staged/head/a real base ref -- it rejects the other two as "unknown base
  // ref". Approximate with "head" (working tree vs HEAD) rather than handing
  // it a target guaranteed to make the analyzer step fail outright.
  const analyzerTarget = target === "all" || target === "uncommitted" ? "head" : target;
  const analyzers = light
    ? "Skip the analyzer step entirely (light policy)."
    : `Run \`python3 ${scriptPath("run_tools.py")} ${analyzerTarget}\` and read .ferret/tool-results.json. `
      + "Treat analyzer findings as evidence and deduplicate equivalent semantic findings.";
  const extra = configFiles.length
    ? `Additional instruction files to honor: ${configFiles.join(", ")}.\n`
    : "";
  return `Run a CodeFerret semantic review of this repository (target: ${target}).

Load the code-ferret skill and follow its methodology exactly.
${extra}
1. Collect context: \`bash ${scriptPath("collect-context.sh")} ${target}\`
   The environment already carries FERRET_BASE_REF, FERRET_INCLUDE_UNTRACKED,
   FERRET_LIGHT, and FERRET_DIR_PATHSPEC — do not override them. When
   FERRET_DIR_PATHSPEC is set, the diff MUST stay restricted to that subtree;
   never widen it back to the whole repository.
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
  const dir = ferretDir(cwd, root);
  const defaultBaseRef = await defaultBase(root);
  const scope = resolveScope(flags, { defaultBase: defaultBaseRef });
  const emitter = createEmitter({ agent: flags.agent, stdout });

  /** Report a review failure on the right channel for the mode, and exit 1. */
  const fail = (message, extra = {}) => {
    if (flags.agent) emitter.error({ message, ...extra });
    else stderr.write(`error: ${message}\n`);
    return 1;
  };

  // Every scope except "uncommitted" diffs against a base ref, so an
  // unresolvable one has to be rejected here, loudly, before anything else
  // runs. Without this the failure surfaced only as git errors swallowed
  // downstream, which read as an empty diff: a typo'd --base, or an
  // auto-detected default in a repo with no main/master, exited 0 and
  // reported a clean review. A green exit must mean "reviewed, nothing
  // found" -- never "could not review".
  if (scope.target !== "uncommitted") {
    const explicit = flags.baseCommit ?? flags.base ?? null;
    if (!scope.baseRef) {
      return fail(
        "could not determine a base branch to compare against: this repository has no "
          + "origin/HEAD, main, or master. Pass --base <branch> or --base-commit <commit>.",
      );
    }
    if (!(await refExists(root, scope.baseRef))) {
      return fail(
        explicit
          ? `base ref "${scope.baseRef}" does not resolve to a commit in this repository. `
            + "Check the spelling, or fetch the branch first."
          : `auto-detected base ref "${scope.baseRef}" does not resolve to a commit in this `
            + "repository. Pass --base <branch> or --base-commit <commit> explicitly.",
      );
    }
  }

  let branch = "unknown";
  try {
    const { stdout: out } = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root });
    branch = out.trim();
  } catch { /* unborn branch */ }

  const pathspec = scopePathspec(root, cwd);
  const files = await scopeFiles(root, scope, pathspec);
  // null means git failed, which is NOT an empty diff (see gitFiles). The base
  // ref was already verified above, so the realistic cause left is an unborn
  // HEAD -- `git diff HEAD` cannot run before the first commit.
  if (files === null) {
    return fail(
      `git could not list changed files for scope "${scope.target}". `
        + "If this repository has no commits yet, make an initial commit first.",
    );
  }

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
    // Route through the same pathspec-aware helper scopeFiles uses -- these
    // candidate counts must reflect the active --dir scope too, or the
    // suggested "narrower" commands (computed against the whole repo) can
    // still be over the limit even after the user already scoped down.
    // These counts only refine the suggestions, so a null (git failed) degrades
    // to "no candidate of that kind" rather than failing the whole command --
    // the oversized-diff error itself is already correct and actionable.
    const candidateBase = scope.baseRef ?? defaultBaseRef;
    const { candidates, candidatesNote } = computeCandidates({
      files,
      maxFiles,
      committedFiles: candidateBase
        ? (await scopedGitFiles(
            root,
            ["diff", `${candidateBase}...HEAD`, "--name-only"],
            pathspec,
          )) ?? []
        : [],
      uncommittedFiles:
        (await scopedGitFiles(root, ["diff", "HEAD", "--name-only"], pathspec)) ?? [],
    });
    const message = `Review scope too large: ${files.length} files (limit ${maxFiles})`;
    if (flags.agent) emitter.error({ message, candidates, candidatesNote });
    else stderr.write(`error: ${message}\n\n${formatCandidates(candidates, candidatesNote)}\n`);
    return 1;
  }

  if (!agent) {
    return fail(
      agentError
        ? agentError.message
        : "No host coding agent found. Install claude, codex, or gemini, or set FERRET_AGENT_CMD. Run `ferret doctor` for details.",
    );
  }

  const agentEnv = {
    ...env,
    // "" rather than null: collect-context.sh reads this as
    // `${FERRET_BASE_REF:-main}`, which treats empty and unset alike, whereas a
    // null would reach the child as the literal string "null". Only reachable
    // as "" for the "uncommitted" target, which never consults a base ref.
    FERRET_BASE_REF: scope.baseRef ?? defaultBaseRef ?? "",
    FERRET_INCLUDE_UNTRACKED: scope.includeUntracked ? "1" : "0",
    FERRET_LIGHT: flags.light ? "1" : "0",
    // --dir's own file-count accounting (scopeFiles/scopedGitFiles above) has
    // respected `pathspec` since Task 10's fix round, but nothing previously
    // told collect-context.sh to actually narrow the diff it hands to the
    // agent -- so a --dir scope's own promise not to expose other subtrees
    // to the (third-party) host agent silently didn't hold. Empty string
    // when unset so collect-context.sh's own default (".") applies.
    FERRET_DIR_PATHSPEC: pathspec ?? "",
  };
  const prompt = buildPrompt({
    target: scope.target,
    light: Boolean(flags.light),
    configFiles: flags.config ?? [],
  });

  // Everything from here on mutates shared per-repo state (last-review.json,
  // last-prompts.json, history.jsonl, stats.json), so it is serialized against
  // other invocations on this repository. Two overlapping runs -- two
  // terminals, or concurrent MCP tool calls -- otherwise delete each other's
  // last-review.json, whichever agent finishes last silently wins both that
  // file and history.jsonl, and a concurrent `ferret review findings` can
  // observe the window where neither exists.
  //
  // Acquired here rather than at the top of runReview on purpose: every check
  // above is read-only and fails fast, and making a misconfigured repo or an
  // oversized diff wait on an unrelated in-flight review would be pure cost.
  //
  // It is also acquired BEFORE the first emitter call, so a blocked run emits
  // one error event and nothing else. Announcing review_context and
  // status:"collecting_context" first would claim work that never started.
  let lock;
  try {
    lock = await acquireReviewLock(dir, { target: scope.target });
  } catch (err) {
    if (err instanceof LockBusyError) return fail(err.message);
    throw err;
  }

  emitter.reviewContext(context);
  emitter.status("collecting_context");

  const started = Date.now();
  // Declared outside the try so the finally can always clear it: an exception
  // between here and the clearInterval below would otherwise leave a repeating
  // timer holding the event loop open after runReview returned.
  let beat = null;
  try {
  // A stale last-review.json from a previous run must not survive into this
  // one: without this, an agent that fails outright (non-zero exit, wrote
  // nothing) or times out leaves the old file in place, `readReview` happily
  // returns it, `!review` is false, and both failure branches below become
  // unreachable -- the CLI reports the previous run's findings as fresh,
  // appends them to permanent history, and exits 0.
  await rm(join(dir, "last-review.json"), { force: true });
  await rm(join(dir, "last-prompts.json"), { force: true });

  beat = setInterval(() => emitter.heartbeat(), HEARTBEAT_MS);
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
  beat = null;

  const review = await readReview(dir);
  if (result.exitCode !== 0 && !review) {
    return fail(
      `Host agent ${agent.name} failed (exit ${result.exitCode}). ${result.stderr.trim()}`,
    );
  }
  if (!review) {
    return fail("The host agent did not write .ferret/last-review.json.");
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
  // them as untrusted. tallySeverities (findings.js) normalizes case, accepts
  // the CodeRabbit wire aliases, and gates on Object.hasOwn against a known
  // key set rather than an `!== undefined` check -- the latter is both
  // case-sensitive and reachable via Object.prototype, so a finding with
  // severity: "constructor" would write a corrupted own "constructor"
  // property that stats.js's aggregate() then string-concatenates into
  // findings_total: permanent, unrecoverable stats corruption from one bad
  // line. Anything still unrecognized is recorded under UNKNOWN rather than
  // dropped, so history can never under-count the findings actually reported.
  const { counts: bySeverity, unknown } = tallySeverities(findings);
  if (unknown) bySeverity.UNKNOWN = unknown;
  const byVector = Object.create(null);
  for (const f of findings) {
    const vec = f.vector ? String(f.vector).toUpperCase() : null;
    if (vec) byVector[vec] = (byVector[vec] ?? 0) + 1;
  }
  await appendHistory(dir, {
    ts: new Date().toISOString(),
    target: scope.target,
    branch,
    // gitFiles returns null when git fails (unborn HEAD), so this must be
    // optional-chained -- indexing [0] on null would throw right at the end of
    // an otherwise successful review.
    commit: (await gitFiles(root, ["rev-parse", "--short", "HEAD"]))?.[0] ?? null,
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
  } finally {
    if (beat) clearInterval(beat);
    await lock.release();
  }
}
