import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { main, parseFlags } from "../src/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "fake-agent.js");
const SEVERITY_FIXTURE = join(HERE, "fixtures", "severity-agent.js");
const ECHO = join(HERE, "fixtures", "echo-args.js");

// agent.js (Task 7) deliberately never uses a shell to invoke the host agent
// (see its module comment), so FERRET_AGENT_CMD must name one literal
// executable with no embedded arguments -- a bare "node <script>" string
// cannot be spawned this way: spawnSync/CreateProcess treats the whole
// string as one (nonexistent) filename and fails with ENOENT, which
// detectAgent turns into "can't be spawned". `FAKE`/`brokenAgentEnv` below
// are kept exactly for that: tests that only need detection to fail
// *softly* (never crash, never spawn) use it deliberately. It is
// guaranteed broken -- do not use it where a test needs a review to
// actually complete.
const FAKE = `${process.execPath} ${FIXTURE}`;
const brokenAgentEnv = { ...process.env, FERRET_AGENT_CMD: FAKE };

// Fix round 2, finding 2: agent.js's detectAgent now accepts an explicit
// JSON argv array in FERRET_AGENT_CMD/FERRET_AGENT (a value starting with
// "["), which is the real, documented way to point it at a program plus
// arguments -- unlike the bare-string form, which can only ever name one
// literal executable. This drives the fixture through the JSON-array form:
// argv[0] is the real node binary (a genuinely installed, spawnable
// executable), the fixture path is the first extra argument, so the child
// is invoked exactly as `node <fixture>`, its entry module resolves
// normally, and it runs to completion and writes .ferret/last-review.json
// like any real host agent would. This replaced an earlier
// NODE_OPTIONS=--import preload workaround from before agent.js supported
// this form -- no longer needed.
function workingAgentEnv(extra = {}, fixture = FIXTURE) {
  return {
    ...process.env,
    FERRET_AGENT_CMD: JSON.stringify([process.execPath, fixture]),
    ...extra,
  };
}

function makeRepo(branch = "main") {
  const dir = mkdtempSync(join(tmpdir(), "ferret-cli-"));
  execFileSync("git", ["init", "-q", "-b", branch], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@t.local"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
  writeFileSync(join(dir, "app.txt"), "baseline\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "baseline"], { cwd: dir });
  return dir;
}

function capture() {
  const chunks = [];
  return { write: (s) => chunks.push(s), text: () => chunks.join("") };
}

/** The final non-empty output line, trimmed -- runReview's plain-mode "Reviewing
 * N file(s)..." banner precedes the agent's own echoed output on stdout. */
function lastLine(text) {
  const lines = text.split("\n").filter((l) => l.trim());
  return lines.at(-1).trim();
}

test("parseFlags reads the review subcommand and scope flags", () => {
  const parsed = parseFlags(["review", "--committed", "--base", "develop"]);
  assert.equal(parsed.command, "review");
  assert.equal(parsed.values.committed, true);
  assert.equal(parsed.values.base, "develop");
});

test("parseFlags treats a bare invocation as review", () => {
  assert.equal(parseFlags([]).command, "review");
});

test("parseFlags recognises the findings subcommand", () => {
  const parsed = parseFlags(["review", "findings"]);
  assert.equal(parsed.command, "review");
  assert.equal(parsed.sub, "findings");
});

test("contradictory scope flags exit 1 before any review runs", async () => {
  // M-6: this must use a *working* fixture agent. With the guaranteed-broken
  // brokenAgentEnv, an implementation that spawned the agent before
  // validating flags would still leave no last-review.json (detectAgent
  // would just throw first) -- the test would pass vacuously either way.
  // A working agent makes "flags were rejected before any spawn" the only
  // way this can pass.
  const cwd = makeRepo();
  writeFileSync(join(cwd, "app.txt"), "baseline\nchanged\n");
  const stderr = capture();
  const code = await main(["review", "--committed", "--uncommitted"], {
    stdout: capture(), stderr, env: workingAgentEnv(), cwd,
  });
  assert.equal(code, 1);
  assert.match(stderr.text(), /--committed cannot be combined with --uncommitted/);
  assert.equal(existsSync(join(cwd, ".ferret")), false);
});

test("--agent surfaces a scope conflict as a parseable error event (I-4)", async () => {
  const cwd = makeRepo();
  const stdout = capture();
  const code = await main(["review", "--committed", "--uncommitted", "--agent"], {
    stdout, stderr: capture(), env: workingAgentEnv(), cwd,
  });
  assert.equal(code, 1);
  const event = JSON.parse(stdout.text().trim());
  assert.equal(event.type, "error");
  assert.match(event.message, /--committed cannot be combined with --uncommitted/);
});

test("--agent surfaces 'not a git repository' as a parseable error event (I-4)", async () => {
  const stdout = capture();
  const code = await main(["review", "--agent"], {
    stdout, stderr: capture(), env: workingAgentEnv(), cwd: mkdtempSync(join(tmpdir(), "ferret-bare-")),
  });
  assert.equal(code, 1);
  const event = JSON.parse(stdout.text().trim());
  assert.equal(event.type, "error");
  assert.match(event.message, /not inside a git repository/);
});

test("a review with changes prints the report and records history", async () => {
  const cwd = makeRepo();
  writeFileSync(join(cwd, "app.txt"), "baseline\nchanged\n");
  const stdout = capture();
  const code = await main(["review", "--uncommitted"], {
    stdout, stderr: capture(), env: workingAgentEnv(), cwd,
  });
  assert.equal(code, 0);
  assert.match(stdout.text(), /Race condition during balance debit\./);
  assert.match(stdout.text(), /1 critical/);
  const history = readFileSync(join(cwd, ".ferret", "history.jsonl"), "utf8").trim();
  assert.equal(JSON.parse(history).by_severity.CRITICAL, 1);
});

test("--agent emits JSONL with review_context, finding, and complete", async () => {
  const cwd = makeRepo();
  writeFileSync(join(cwd, "app.txt"), "baseline\nchanged\n");
  const stdout = capture();
  const code = await main(["review", "--uncommitted", "--agent"], {
    stdout, stderr: capture(), env: workingAgentEnv(), cwd,
  });
  assert.equal(code, 0);
  const events = stdout.text().trimEnd().split("\n").map((l) => JSON.parse(l));
  const types = events.map((e) => e.type);
  assert.ok(types.includes("review_context"));
  assert.ok(types.includes("finding"));
  assert.equal(types.at(-1), "complete");
  assert.equal(events.find((e) => e.type === "finding").severity, "critical");
});

test("C-1: a failed agent does not report stale findings or append history", async () => {
  const cwd = makeRepo();
  writeFileSync(join(cwd, "app.txt"), "baseline\nchanged\n");
  mkdirSync(join(cwd, ".ferret"), { recursive: true });
  writeFileSync(
    join(cwd, ".ferret", "last-review.json"),
    JSON.stringify({
      target: "all",
      findings: [{
        file: "stale.ts", line: 1, character: 1, severity: "CRITICAL",
        vector: "LOGIC", confidence: "HIGH",
        message: "STALE finding from a previous run", explanation: "e", patch: null,
      }],
    }),
  );
  const stdout = capture();
  const stderr = capture();
  const code = await main(["review", "--uncommitted"], {
    stdout, stderr, env: workingAgentEnv({ FAKE_AGENT_FAIL: "1" }), cwd,
  });
  assert.equal(code, 1);
  assert.doesNotMatch(stdout.text(), /STALE finding/);
  assert.match(stderr.text(), /Host agent .* failed \(exit 3\)/);
  assert.equal(existsSync(join(cwd, ".ferret", "history.jsonl")), false);
});

test("I-3: a lowercase severity is still tallied in history and the plain-mode report", async () => {
  const cwd = makeRepo();
  writeFileSync(join(cwd, "app.txt"), "baseline\nchanged\n");
  const stdout = capture();
  const code = await main(["review", "--uncommitted"], {
    stdout, stderr: capture(),
    env: workingAgentEnv({ FAKE_SEVERITY: "critical" }, SEVERITY_FIXTURE),
    cwd,
  });
  assert.equal(code, 0);
  assert.match(stdout.text(), /1 critical/);
  const history = JSON.parse(readFileSync(join(cwd, ".ferret", "history.jsonl"), "utf8").trim());
  assert.equal(history.by_severity.CRITICAL, 1);
});

test("I-3: a prototype-colliding severity does not leak into history", async () => {
  const cwd = makeRepo();
  writeFileSync(join(cwd, "app.txt"), "baseline\nchanged\n");
  const stdout = capture();
  const code = await main(["review", "--uncommitted"], {
    stdout, stderr: capture(),
    env: workingAgentEnv({ FAKE_SEVERITY: "constructor" }, SEVERITY_FIXTURE),
    cwd,
  });
  assert.equal(code, 0);
  const history = JSON.parse(readFileSync(join(cwd, ".ferret", "history.jsonl"), "utf8").trim());
  assert.deepEqual(history.by_severity, { CRITICAL: 0, WARNING: 0, SUGGESTION: 0 });
  assert.equal(Object.hasOwn(history.by_severity, "constructor"), false);
});

test("I-5: a non-numeric FERRET_MAX_FILES falls back to the default limit, not disables it", async () => {
  const cwd = makeRepo();
  for (let i = 0; i < 55; i += 1) writeFileSync(join(cwd, `f${i}.txt`), "x\n");
  execFileSync("git", ["add", "."], { cwd });
  execFileSync("git", ["commit", "-qm", "many files"], { cwd });
  for (let i = 0; i < 55; i += 1) writeFileSync(join(cwd, `f${i}.txt`), "changed\n");

  const stderr = capture();
  const code = await main(["review", "--uncommitted"], {
    stdout: capture(), stderr, env: workingAgentEnv({ FERRET_MAX_FILES: "abc" }), cwd,
  });
  assert.equal(code, 1);
  assert.match(stderr.text(), /Review scope too large: 55 files \(limit 50\)/);
});

test("I-5: an empty FERRET_MAX_FILES also falls back to the default limit", async () => {
  const cwd = makeRepo();
  writeFileSync(join(cwd, "app.txt"), "baseline\nchanged\n");
  const stdout = capture();
  const stderr = capture();
  const code = await main(["review", "--uncommitted"], {
    stdout, stderr, env: workingAgentEnv({ FERRET_MAX_FILES: "" }), cwd,
  });
  assert.equal(code, 0);
  assert.doesNotMatch(stderr.text(), /Review scope too large/);
});

test("I-2: --dir narrows scope to a subtree via a git pathspec", async () => {
  const cwd = makeRepo();
  mkdirSync(join(cwd, "src"));
  mkdirSync(join(cwd, "other"));
  writeFileSync(join(cwd, "src", "a.txt"), "a\n");
  writeFileSync(join(cwd, "other", "b.txt"), "b\n");
  execFileSync("git", ["add", "."], { cwd });
  execFileSync("git", ["commit", "-qm", "seed"], { cwd });
  writeFileSync(join(cwd, "src", "a.txt"), "a changed\n");
  writeFileSync(join(cwd, "other", "b.txt"), "b changed\n");

  const env = workingAgentEnv();

  const full = capture();
  const fullCode = await main(["review", "--uncommitted", "--agent"], {
    stdout: full, stderr: capture(), env, cwd,
  });
  assert.equal(fullCode, 0);
  const fullFiles = JSON.parse(full.text().split("\n")[0]).files;

  const scoped = capture();
  const scopedCode = await main(["review", "--uncommitted", "--agent", "--dir", join(cwd, "src")], {
    stdout: scoped, stderr: capture(), env, cwd,
  });
  assert.equal(scopedCode, 0);
  const scopedFiles = JSON.parse(scoped.text().split("\n")[0]).files;

  assert.equal(fullFiles, 2);
  assert.equal(scopedFiles, 1);
});

test("fix round 2, finding 1: oversized-diff candidates respect the active --dir scope", async () => {
  // Probe from the finding: 2 changed files under src/, 60 under other/. Run
  // scoped to --dir src with a limit of 1 -- the scope check correctly sees
  // only the 2 files under src/ and refuses, but before this fix the
  // candidates were computed against gitFiles(root, ...) directly (bypassing
  // scopeFiles' pathspec), so "ferret review --uncommitted" was suggested at
  // ~62 files -- the whole repo, ignoring the --dir the user already
  // applied, and still over the limit either way.
  const cwd = makeRepo();
  mkdirSync(join(cwd, "src"));
  mkdirSync(join(cwd, "other"));
  writeFileSync(join(cwd, "src", "a.txt"), "a\n");
  writeFileSync(join(cwd, "src", "b.txt"), "b\n");
  for (let i = 0; i < 60; i += 1) writeFileSync(join(cwd, "other", `f${i}.txt`), "x\n");
  execFileSync("git", ["add", "."], { cwd });
  execFileSync("git", ["commit", "-qm", "seed"], { cwd });
  writeFileSync(join(cwd, "src", "a.txt"), "a changed\n");
  writeFileSync(join(cwd, "src", "b.txt"), "b changed\n");
  for (let i = 0; i < 60; i += 1) writeFileSync(join(cwd, "other", `f${i}.txt`), "changed\n");

  const stderr = capture();
  const code = await main(
    ["review", "--uncommitted", "--dir", join(cwd, "src")],
    { stdout: capture(), stderr, env: workingAgentEnv({ FERRET_MAX_FILES: "1" }), cwd },
  );
  assert.equal(code, 1);
  assert.match(stderr.text(), /Review scope too large: 2 files \(limit 1\)/);
  assert.match(stderr.text(), /ferret review --uncommitted\s*\n\s*~2 files/);
  assert.doesNotMatch(stderr.text(), /~62 files/);
});

test("an empty diff emits the review_skipped sequence and never spawns an agent", async () => {
  const cwd = makeRepo();
  const stdout = capture();
  const code = await main(["review", "--uncommitted", "--agent"], {
    stdout, stderr: capture(), env: brokenAgentEnv, cwd,
  });
  assert.equal(code, 0);
  const events = stdout.text().trimEnd().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(events.map((e) => e.type), ["review_context", "status", "complete"]);
  assert.equal(events[2].message, "No changes detected");
  assert.equal(existsSync(join(cwd, ".ferret", "last-review.json")), false);
});

// --- base-ref resolution -----------------------------------------------
//
// Regression suite for the silent-clean-pass bug: git failures used to be
// swallowed into an empty file list, which is indistinguishable from a clean
// tree, so an unusable base ref exited 0 and reported "No changes detected".
// A green exit must only ever mean "reviewed, found nothing". Each of these
// uses a *working* fixture agent, so "the review never ran" is the only way
// they can pass -- with the guaranteed-broken agent they would pass vacuously.

test("a typo'd --base exits 1 instead of reporting a clean review", async () => {
  const cwd = makeRepo();
  writeFileSync(join(cwd, "app.txt"), "baseline\nchanged\n");
  execFileSync("git", ["add", "."], { cwd });
  execFileSync("git", ["commit", "-qm", "change"], { cwd });
  const stderr = capture();
  const stdout = capture();
  const code = await main(["review", "--base", "totally-bogus-ref"], {
    stdout, stderr, env: workingAgentEnv(), cwd,
  });
  assert.equal(code, 1);
  assert.match(stderr.text(), /does not resolve to a commit/);
  assert.doesNotMatch(stdout.text(), /No changes detected/);
  assert.equal(existsSync(join(cwd, ".ferret", "last-review.json")), false);
});

test("a typo'd --base-commit exits 1 under --committed too", async () => {
  const cwd = makeRepo();
  const stderr = capture();
  const code = await main(["review", "--committed", "--base-commit", "deadbeef"], {
    stdout: capture(), stderr, env: workingAgentEnv(), cwd,
  });
  assert.equal(code, 1);
  assert.match(stderr.text(), /does not resolve to a commit/);
});

test("a typo'd --base reaches --agent as an error event, not review_skipped", async () => {
  const cwd = makeRepo();
  const stdout = capture();
  const code = await main(["review", "--base", "totally-bogus-ref", "--agent"], {
    stdout, stderr: capture(), env: workingAgentEnv(), cwd,
  });
  assert.equal(code, 1);
  const events = stdout.text().trimEnd().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(events.map((e) => e.type), ["error"]);
  assert.match(events[0].message, /does not resolve to a commit/);
});

test("a repo with no main/master fails loudly instead of reviewing against a phantom base", async () => {
  // No --base at all: defaultBase() finds no origin/HEAD, main, or master, and
  // must report that rather than falling back to a literal "main" that does
  // not exist. This is the no-user-error path -- it fires on any repo whose
  // default branch is named something else.
  const cwd = makeRepo("trunk");
  writeFileSync(join(cwd, "app.txt"), "baseline\nchanged\n");
  execFileSync("git", ["add", "."], { cwd });
  execFileSync("git", ["commit", "-qm", "change"], { cwd });
  const stderr = capture();
  const code = await main(["review"], {
    stdout: capture(), stderr, env: workingAgentEnv(), cwd,
  });
  assert.equal(code, 1);
  assert.match(stderr.text(), /could not determine a base branch/);
  assert.match(stderr.text(), /--base/);
});

test("--uncommitted needs no base ref and still works without main/master", async () => {
  const cwd = makeRepo("trunk");
  writeFileSync(join(cwd, "app.txt"), "baseline\nchanged\n");
  const stdout = capture();
  const code = await main(["review", "--uncommitted", "--agent"], {
    stdout, stderr: capture(), env: workingAgentEnv(), cwd,
  });
  assert.equal(code, 0);
  const types = stdout.text().trimEnd().split("\n").map((l) => JSON.parse(l).type);
  assert.ok(types.includes("complete"));
  assert.equal(existsSync(join(cwd, ".ferret", "last-review.json")), true);
});

test("a valid base ref with a genuinely empty diff still exits 0", async () => {
  // The counterweight to the tests above: hardening the git-failure path must
  // not turn a real clean tree into an error.
  const cwd = makeRepo();
  const stdout = capture();
  const code = await main(["review", "--base", "main", "--agent"], {
    stdout, stderr: capture(), env: brokenAgentEnv, cwd,
  });
  assert.equal(code, 0);
  const events = stdout.text().trimEnd().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(events.map((e) => e.type), ["review_context", "status", "complete"]);
  assert.equal(events[2].message, "No changes detected");
});

test("review findings replays without spawning an agent", async () => {
  const cwd = makeRepo();
  mkdirSync(join(cwd, ".ferret"), { recursive: true });
  writeFileSync(
    join(cwd, ".ferret", "last-review.json"),
    JSON.stringify({
      target: "all",
      findings: [{
        file: "a.ts", line: 1, character: 1, severity: "WARNING",
        vector: "LOGIC", confidence: "MEDIUM", message: "replayed finding",
        explanation: "e", patch: null,
      }],
    }),
  );
  const stdout = capture();
  const code = await main(["review", "findings"], {
    stdout, stderr: capture(), env: { ...process.env }, cwd,
  });
  assert.equal(code, 0);
  assert.match(stdout.text(), /replayed finding/);
});

test("review findings exits 1 when there is nothing stored", async () => {
  const stderr = capture();
  const code = await main(["review", "findings"], {
    stdout: capture(), stderr, env: { ...process.env }, cwd: makeRepo(),
  });
  assert.equal(code, 1);
  assert.match(stderr.text(), /No stored review/);
});

test("--show-prompts prints saved prompts without reviewing", async () => {
  const cwd = makeRepo();
  mkdirSync(join(cwd, ".ferret"), { recursive: true });
  writeFileSync(
    join(cwd, ".ferret", "last-prompts.json"),
    JSON.stringify({ target: "all", prompts: [{ name: "review", text: "PROMPT BODY" }] }),
  );
  const stdout = capture();
  const code = await main(["review", "--show-prompts"], {
    stdout, stderr: capture(), env: { ...process.env }, cwd,
  });
  assert.equal(code, 0);
  assert.match(stdout.text(), /PROMPT BODY/);
});

test("doctor reports every check and returns a usable exit code", async () => {
  // Fix round 2: the deterministic exit-code assertion moved to the "M-7"
  // test below (which uses brokenAgentEnv and can actually fail). This test
  // just checks doctor is wired up and reports the checks, with a working
  // agent so it doesn't (incidentally) also exercise the failure path.
  const stdout = capture();
  await main(["doctor"], {
    stdout, stderr: capture(), env: workingAgentEnv(), cwd: makeRepo(),
  });
  assert.match(stdout.text(), /host agent/);
  assert.match(stdout.text(), /git repository/);
});

test("M-7: doctor surfaces the actionable FERRET_AGENT_CMD message when it can't spawn", async () => {
  // brokenAgentEnv is guaranteed broken (see the comment where it's
  // defined), so this is deterministic: "host agent" must fail with the
  // actionable override message, and the run must exit 1. Previously this
  // test only asserted `code === 0 || code === 1`, which no implementation
  // could ever fail.
  const stdout = capture();
  const code = await main(["doctor"], {
    stdout, stderr: capture(), env: brokenAgentEnv, cwd: makeRepo(),
  });
  assert.equal(code, 1);
  assert.match(stdout.text(), /FERRET_AGENT_CMD/);
  assert.match(stdout.text(), /can't be spawned/);
  assert.match(stdout.text(), /git repository/);
});

test("stats reports an empty history", async () => {
  const stdout = capture();
  const code = await main(["stats"], {
    stdout, stderr: capture(), env: { ...process.env }, cwd: makeRepo(),
  });
  assert.equal(code, 0);
  assert.match(stdout.text(), /No reviews recorded yet/);
});

test("--help exits 0 and lists the command surface", async () => {
  const stdout = capture();
  const code = await main(["--help"], {
    stdout, stderr: capture(), env: { ...process.env }, cwd: makeRepo(),
  });
  assert.equal(code, 0);
  assert.match(stdout.text(), /ferret review/);
  assert.match(stdout.text(), /--agent/);
  assert.match(stdout.text(), /doctor/);
});

test("running outside a git repository exits 1", async () => {
  const stderr = capture();
  const code = await main(["review"], {
    stdout: capture(), stderr, env: brokenAgentEnv, cwd: mkdtempSync(join(tmpdir(), "ferret-bare-")),
  });
  assert.equal(code, 1);
  assert.match(stderr.text(), /not inside a git repository/);
});

// Whole-branch review finding: run_tools.py predates the "all"/"uncommitted"
// targets collect-context.sh gained in this plan -- its own validate_target()
// only understands staged/head/a real base ref and raises "unknown base ref"
// for the other two, silently breaking the analyzer step for the CLI's
// default target ("all") and --uncommitted. buildPrompt() must approximate
// with "head" for those two, leaving a real base ref (from --committed/--base)
// untouched. echo-args.js reports back the exact prompt text sent to the
// agent's argv so this pins the substitution without spawning a real analyzer.
test("the analyzer step substitutes 'head' for the run_tools.py-incompatible 'uncommitted' target", async () => {
  const cwd = makeRepo();
  writeFileSync(join(cwd, "app.txt"), "baseline\nchanged\n");
  const stdout = capture();
  const code = await main(["review", "--uncommitted"], {
    stdout, stderr: capture(), env: workingAgentEnv({}, ECHO), cwd,
  });
  assert.equal(code, 1); // echo-args never writes last-review.json
  const [prompt] = JSON.parse(lastLine(stdout.text()));
  assert.match(prompt, /run_tools\.py head/);
  assert.doesNotMatch(prompt, /run_tools\.py uncommitted/);
});

test("the analyzer step substitutes 'head' for the run_tools.py-incompatible 'all' (default) target", async () => {
  const cwd = makeRepo();
  writeFileSync(join(cwd, "app.txt"), "baseline\nchanged\n");
  const stdout = capture();
  const code = await main(["review"], {
    stdout, stderr: capture(), env: workingAgentEnv({}, ECHO), cwd,
  });
  assert.equal(code, 1);
  const [prompt] = JSON.parse(lastLine(stdout.text()));
  assert.match(prompt, /run_tools\.py head/);
  assert.doesNotMatch(prompt, /run_tools\.py all/);
});

test("the analyzer step passes a real base ref through unchanged", async () => {
  const cwd = makeRepo();
  execFileSync("git", ["checkout", "-q", "-b", "feature"], { cwd });
  writeFileSync(join(cwd, "app.txt"), "baseline\nchanged\n");
  execFileSync("git", ["add", "."], { cwd });
  execFileSync("git", ["commit", "-qm", "change"], { cwd });
  const stdout = capture();
  const code = await main(["review", "--committed", "--base", "main"], {
    stdout, stderr: capture(), env: workingAgentEnv({}, ECHO), cwd,
  });
  assert.equal(code, 1);
  const [prompt] = JSON.parse(lastLine(stdout.text()));
  assert.match(prompt, /run_tools\.py main/);
});
