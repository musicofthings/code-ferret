import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { main, parseFlags } from "../src/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "fake-agent.js");
const SEVERITY_FIXTURE = join(HERE, "fixtures", "severity-agent.js");

// agent.js (Task 7) deliberately never uses a shell to invoke the host agent
// (see its module comment), so FERRET_AGENT_CMD must name one literal
// executable with no embedded arguments -- a "node <script>" string cannot
// be spawned this way: spawnSync/CreateProcess treats the whole string as
// one (nonexistent) filename and fails with ENOENT, which detectAgent turns
// into "can't be spawned". `FAKE`/`brokenAgentEnv` below are kept exactly
// for that: tests that only need detection to fail *softly* (never crash,
// never spawn) use it deliberately. It is guaranteed broken -- do not use it
// where a test needs a review to actually complete.
const FAKE = `${process.execPath} ${FIXTURE}`;
const brokenAgentEnv = { ...process.env, FERRET_AGENT_CMD: FAKE };

// To drive a review to genuine completion without spawning a real coding
// agent, point FERRET_AGENT_CMD at node itself (a real, single, spawnable
// executable -- defaultIsInstalled's `node --version` probe succeeds
// trivially, no preload needed) and use NODE_OPTIONS=--import to preload a
// fixture for the *actual* invocation. The fixture's whole body is
// synchronous top-level code ending in process.exit(), so it completes --
// writing .ferret/last-review.json and printing its progress lines --
// before node ever tries to resolve the (huge, non-path) review prompt as an
// entry module. Building the env per-call (rather than mutating the real
// process.env, as an earlier version of this file did) means the
// isInstalled probe never sees NODE_OPTIONS and never runs the fixture, so
// there is no stray cli/.ferret/ side effect to clean up.
function workingAgentEnv(extra = {}, fixture = FIXTURE) {
  return {
    ...process.env,
    FERRET_AGENT_CMD: process.execPath,
    NODE_OPTIONS: `--import ${pathToFileURL(fixture).href}`,
    ...extra,
  };
}

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "ferret-cli-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
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
  const stdout = capture();
  const code = await main(["doctor"], {
    stdout, stderr: capture(), env: workingAgentEnv(), cwd: makeRepo(),
  });
  assert.ok(code === 0 || code === 1);
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
