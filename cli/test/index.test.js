import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { main, parseFlags } from "../src/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "fake-agent.js");
const FAKE = `${process.execPath} ${FIXTURE}`;

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

const baseEnv = { ...process.env, FERRET_AGENT_CMD: FAKE };

// agent.js (Task 7) deliberately never uses a shell to invoke the host
// agent (see its module comment), so FERRET_AGENT_CMD must name one literal
// executable with no embedded arguments -- a "node <script>" string cannot
// be spawned this way: spawnSync/CreateProcess treats the whole string as
// one (nonexistent) filename and fails with ENOENT, which detectAgent turns
// into "can't be spawned". That means `baseEnv` above (kept for the tests
// that only need detection to fail *softly*, e.g. the empty-diff case)
// cannot actually drive a review to completion on this platform.
//
// To exercise a genuine end-to-end review without spawning a real coding
// agent, point FERRET_AGENT_CMD at node itself (a real, single, spawnable
// executable) and use NODE_OPTIONS=--import to preload the fixture. The
// fixture's whole body runs synchronously and calls process.exit() at the
// end, so it completes -- writing .ferret/last-review.json and printing its
// progress lines -- before node ever tries to resolve the (huge, non-path)
// review prompt as an entry module. This still drives the fixture through
// FERRET_AGENT_CMD, as required; it does not spawn a real agent, make a
// network call, or bypass agent.js.
const FIXTURE_IMPORT = pathToFileURL(FIXTURE).href;

async function withFixtureAgent(run) {
  const prevNodeOptions = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = `--import ${FIXTURE_IMPORT}`;
  try {
    const env = { ...process.env, FERRET_AGENT_CMD: process.execPath };
    return await run(env);
  } finally {
    if (prevNodeOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = prevNodeOptions;
    // The isInstalled probe (`node --version`) also preloads the fixture and
    // inherits the test runner's own cwd (defaultIsInstalled passes no cwd),
    // so it incidentally writes a throwaway .ferret/ next to this test file.
    // It's gitignored either way, but clean it up so the working tree stays
    // tidy.
    rmSync(join(HERE, "..", ".ferret"), { recursive: true, force: true });
  }
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
  const cwd = makeRepo();
  const stderr = capture();
  const code = await main(["review", "--committed", "--uncommitted"], {
    stdout: capture(), stderr, env: baseEnv, cwd,
  });
  assert.equal(code, 1);
  assert.match(stderr.text(), /--committed cannot be combined with --uncommitted/);
  assert.equal(existsSync(join(cwd, ".ferret", "last-review.json")), false);
});

test("a review with changes prints the report and records history", async () => {
  const cwd = makeRepo();
  writeFileSync(join(cwd, "app.txt"), "baseline\nchanged\n");
  const stdout = capture();
  const code = await withFixtureAgent((env) =>
    main(["review", "--uncommitted"], { stdout, stderr: capture(), env, cwd }),
  );
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
  const code = await withFixtureAgent((env) =>
    main(["review", "--uncommitted", "--agent"], { stdout, stderr: capture(), env, cwd }),
  );
  assert.equal(code, 0);
  const events = stdout.text().trimEnd().split("\n").map((l) => JSON.parse(l));
  const types = events.map((e) => e.type);
  assert.ok(types.includes("review_context"));
  assert.ok(types.includes("finding"));
  assert.equal(types.at(-1), "complete");
  assert.equal(events.find((e) => e.type === "finding").severity, "critical");
});

test("an empty diff emits the review_skipped sequence and never spawns an agent", async () => {
  const cwd = makeRepo();
  const stdout = capture();
  const code = await main(["review", "--uncommitted", "--agent"], {
    stdout, stderr: capture(), env: baseEnv, cwd,
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
  // Whether the host machine has claude/codex/gemini installed is not this
  // test's business — Task 9 covers the pass/fail branches directly. Here we
  // only assert the command is wired up and reports the checks.
  const stdout = capture();
  const code = await main(["doctor"], {
    stdout, stderr: capture(), env: baseEnv, cwd: makeRepo(),
  });
  assert.ok(code === 0 || code === 1);
  assert.match(stdout.text(), /host agent/);
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
    stdout: capture(), stderr, env: baseEnv, cwd: mkdtempSync(join(tmpdir(), "ferret-bare-")),
  });
  assert.equal(code, 1);
  assert.match(stderr.text(), /not inside a git repository/);
});
