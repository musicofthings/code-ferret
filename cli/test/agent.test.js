import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  detectAgent,
  runAgent,
  AGENTS,
  CLAUDE_ALLOWED_TOOLS,
  defaultIsInstalled,
} from "../src/agent.js";

const WIN = process.platform === "win32";
const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE = join(HERE, "fixtures", "fake-agent.js");
const ECHO = join(HERE, "fixtures", "echo-args.js");
const SHIM = join(HERE, "fixtures", "fake-shim.cmd");
const CHUNKY = join(HERE, "fixtures", "chunky-agent.js");
const SLEEPY = join(HERE, "fixtures", "sleepy-agent.js");

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "ferret-agent-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

test("detectAgent prefers claude, then codex, then gemini", () => {
  const installed = new Set(["codex", "gemini"]);
  const agent = detectAgent({ env: {}, isInstalled: (c) => installed.has(c) });
  assert.equal(agent.name, "codex");
  const all = detectAgent({ env: {}, isInstalled: () => true });
  assert.equal(all.name, "claude");
  assert.deepEqual(AGENTS.map((a) => a.name), ["claude", "codex", "gemini"]);
});

test("detectAgent returns null when nothing is installed", () => {
  assert.equal(detectAgent({ env: {}, isInstalled: () => false }), null);
});

test("FERRET_AGENT_CMD overrides detection", () => {
  const agent = detectAgent({
    env: { FERRET_AGENT_CMD: "my-agent" },
    isInstalled: () => true,
  });
  assert.equal(agent.name, "custom");
  assert.equal(agent.cmd, "my-agent");
  assert.deepEqual(agent.args("hello"), ["hello"]);
});

// Fix round 2, finding 2: a bare override is still a single literal
// executable path, byte-for-byte as before -- including one containing a
// space (the common real-world Windows case, `C:\Program Files\...\node.exe`)
// which must NOT be split.
test("a bare FERRET_AGENT_CMD containing a space is still one literal path, not split", () => {
  const withSpace = "C:\\Program Files\\nodejs\\node.exe";
  const agent = detectAgent({
    env: { FERRET_AGENT_CMD: withSpace },
    isInstalled: (cmd) => cmd === withSpace,
  });
  assert.equal(agent.cmd, withSpace);
  assert.deepEqual(agent.args("hello"), ["hello"]);
});

// Fix round 2, finding 2: shell:false means FERRET_AGENT_CMD can only ever
// name one literal executable -- "node wrapper.js" can never be spawned,
// and whitespace-splitting was rejected as the fix (it would break the path-
// with-a-space case above). A JSON array is the unambiguous alternative:
// argv[0] is probed by isInstalled, the rest are prepended to the prompt.
test("a JSON-array FERRET_AGENT_CMD resolves to the right cmd and args", () => {
  const seen = [];
  const agent = detectAgent({
    env: { FERRET_AGENT_CMD: '["/usr/bin/node", "wrapper.js", "--flag"]' },
    isInstalled: (cmd) => { seen.push(cmd); return true; },
  });
  assert.equal(agent.name, "custom");
  assert.equal(agent.cmd, "/usr/bin/node");
  // isInstalled must probe argv[0] only, never the full array or a joined string.
  assert.deepEqual(seen, ["/usr/bin/node"]);
  assert.deepEqual(agent.args("the prompt"), ["wrapper.js", "--flag", "the prompt"]);
});

test("a malformed JSON-array FERRET_AGENT_CMD throws an actionable message, not a raw SyntaxError", () => {
  assert.throws(
    () => detectAgent({
      env: { FERRET_AGENT_CMD: '["unterminated' },
      isInstalled: () => true,
    }),
    (err) => {
      assert.ok(!(err instanceof SyntaxError), "must not leak a raw SyntaxError");
      assert.match(err.message, /FERRET_AGENT_CMD/);
      assert.match(err.message, /JSON array/);
      return true;
    },
  );
});

test("a JSON value that parses but isn't a non-empty string array throws an actionable message", () => {
  assert.throws(
    () => detectAgent({
      env: { FERRET_AGENT_CMD: "[42, true]" },
      isInstalled: () => true,
    }),
    (err) => {
      assert.match(err.message, /FERRET_AGENT_CMD/);
      assert.match(err.message, /array of strings/);
      return true;
    },
  );
});

// Fix round 2, finding 2: the "can't be spawned" message previously
// misdiagnosed "cmd with arguments" as a PATH/shim problem. It must now
// point the user at the JSON-array form instead of sending them chasing a
// PATH issue that isn't the actual cause.
test("the 'can't be spawned' message points a multi-word override at the JSON-array form", () => {
  assert.throws(
    () => detectAgent({
      env: { FERRET_AGENT_CMD: "claude --model opus" },
      isInstalled: () => false,
    }),
    (err) => {
      assert.match(err.message, /JSON array/);
      assert.match(err.message, /FERRET_AGENT_CMD/);
      return true;
    },
  );
});

// Fix round 3, finding 4: the override must not exempt itself from the
// "an agent runAgent cannot spawn must not be reported as installed"
// guarantee, and the failure must be actionable, not a generic
// "no agent found".
test("FERRET_AGENT_CMD is rejected with an actionable error when it cannot be spawned", () => {
  assert.throws(
    () => detectAgent({ env: { FERRET_AGENT_CMD: "my-agent" }, isInstalled: () => false }),
    (err) => {
      assert.match(err.message, /my-agent/);
      assert.match(err.message, /FERRET_AGENT_CMD/);
      return true;
    },
  );
});

test("the claude allowlist is scoped to CodeFerret's own tooling", () => {
  assert.match(CLAUDE_ALLOWED_TOOLS, /Bash\(bash:\*\)/);
  assert.match(CLAUDE_ALLOWED_TOOLS, /Bash\(python3:\*\)/);
  assert.doesNotMatch(CLAUDE_ALLOWED_TOOLS, /dangerously/i);
});

test("runAgent streams stdout lines and surfaces the findings file", async () => {
  const cwd = makeRepo();
  const lines = [];
  const result = await runAgent({
    agent: { name: "custom", cmd: process.execPath, args: () => [FAKE] },
    prompt: "review",
    cwd,
    onLine: (l) => lines.push(l),
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(lines, ["collecting context", "running analyzers"]);
  const review = JSON.parse(readFileSync(join(cwd, ".ferret", "last-review.json"), "utf8"));
  assert.equal(review.findings[0].severity, "CRITICAL");
});

test("runAgent reports a non-zero exit and captures stderr", async () => {
  const cwd = makeRepo();
  const result = await runAgent({
    agent: { name: "custom", cmd: process.execPath, args: () => [FAKE] },
    prompt: "review",
    cwd,
    env: { ...process.env, FAKE_AGENT_FAIL: "1" },
  });
  assert.equal(result.exitCode, 3);
  assert.match(result.stderr, /simulated agent failure/);
});

test("runAgent resolves with exitCode 1 when the binary is missing", async () => {
  const result = await runAgent({
    agent: { name: "custom", cmd: "definitely-not-a-real-binary-xyz", args: () => [] },
    prompt: "review",
    cwd: makeRepo(),
  });
  assert.equal(result.exitCode, 1);
});

// Fix round 1: runAgent must never let a shell re-lex the prompt. It must
// round-trip arbitrary prompt content into the child's argv byte-for-byte,
// including quotes, %-expansion, shell metacharacters, and embedded newlines.
// No test here spawns a live agent — echo-args.js only reports back argv.
const ROUND_TRIP_PROMPTS = [
  ["embedded double quotes", 'check <file> <vector> "<message>"'],
  ["percent-expansion", "pct-%PATH%-end"],
  ["shell metacharacters, no spaces", "a&b|c^d<e>f(g)h!i"],
  ["embedded newline", "line one\nline two"],
];

for (const [label, prompt] of ROUND_TRIP_PROMPTS) {
  test(`runAgent delivers a prompt with ${label} to argv untouched`, async () => {
    const lines = [];
    const result = await runAgent({
      agent: { name: "custom", cmd: process.execPath, args: (p) => [ECHO, p] },
      prompt,
      cwd: makeRepo(),
      onLine: (l) => lines.push(l),
    });
    assert.equal(result.exitCode, 0);
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0]), [prompt]);
  });
}

// Fix round 2: detection and invocation must agree, or `ferret doctor` can
// report an agent as installed that `ferret review` then fails to launch.
// fake-shim.cmd is a real (inert) Windows batch file fixture -- not a live
// agent -- used only to reproduce the "can spawnSync/spawn even reach this
// binary" question that a real npm-installed codex/gemini .cmd shim raises.
test(
  "defaultIsInstalled reports false for a target runAgent cannot actually spawn",
  { skip: !WIN && "fake-shim.cmd only exercises the Windows .cmd-shim path" },
  () => {
    assert.equal(defaultIsInstalled(SHIM), false);
  },
);

test("defaultIsInstalled reports true for a target that really is spawnable", () => {
  assert.equal(defaultIsInstalled(process.execPath), true);
});

test(
  "runAgent turns a .cmd/.bat shim's spawn failure into an actionable message, not a bare errno",
  { skip: !WIN && "fake-shim.cmd only exercises the Windows .cmd-shim path" },
  async () => {
    const result = await runAgent({
      agent: { name: "custom", cmd: SHIM, args: () => [] },
      prompt: "review",
      cwd: makeRepo(),
    });
    assert.equal(result.exitCode, 1);
    assert.doesNotMatch(result.stderr, /^spawn.*EINVAL$/);
    assert.match(result.stderr, /\.cmd/i);
    assert.match(result.stderr, /FERRET_AGENT_CMD/);
  },
);

// Fix round 3, findings 1 & 5: chunk-boundary correctness has no coverage
// otherwise. chunky-agent.js writes, with real delays between writes so each
// lands as its own 'data' event: a line split mid-line across two chunks, a
// \r\n line ending, a multibyte UTF-8 character ("日") split mid-sequence
// across a chunk boundary, and a final line with no trailing newline. Before
// the setEncoding("utf8") fix, the multibyte case corrupted into U+FFFD.
test("runAgent handles split lines, CRLF, a multibyte split, and an unterminated final line", async () => {
  const lines = [];
  const result = await runAgent({
    agent: { name: "custom", cmd: process.execPath, args: () => [CHUNKY] },
    prompt: "review",
    cwd: makeRepo(),
    onLine: (l) => lines.push(l),
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(lines, [
    "first line",
    "second line",
    "third 日本語 line",
    "unterminated last line",
  ]);
});

// Fix round 3, findings 2 & 5: a timeout must be distinguishable from any
// other failure (both previously resolved {exitCode:1, stderr:""}), and the
// promise must still settle even against a child that ignores SIGTERM (what
// sleepy-agent.js models -- on POSIX this is the scenario the SIGKILL grace
// timer exists for; on Windows SIGTERM already maps to TerminateProcess, so
// this proves the fast path without needing the grace timer to fire).
test("runAgent distinguishes a timeout from other failures and still resolves", async () => {
  const start = Date.now();
  const result = await runAgent({
    agent: { name: "custom", cmd: process.execPath, args: () => [SLEEPY] },
    prompt: "review",
    cwd: makeRepo(),
    timeoutMs: 300,
  });
  const elapsed = Date.now() - start;
  assert.equal(result.exitCode, 1);
  assert.equal(result.timedOut, true);
  assert.match(result.stderr, /timed out/i);
  assert.match(result.stderr, /300/);
  // Resolved well before the 5s SIGKILL grace period would have to fire.
  assert.ok(elapsed < 4000, `expected to resolve quickly, took ${elapsed}ms`);
});
