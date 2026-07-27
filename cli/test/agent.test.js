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
