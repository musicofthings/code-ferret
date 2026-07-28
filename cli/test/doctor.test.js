import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDoctor, formatDoctor } from "../src/doctor.js";

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "ferret-doctor-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

const find = (result, name) => result.checks.find((c) => c.name === name);

test("a healthy environment passes with exit code 0", async () => {
  const result = await runDoctor({
    cwd: makeRepo(),
    env: { FERRET_AGENT_CMD: "fake-agent" },
    isInstalled: () => true,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(find(result, "git repository").status, "ok");
  assert.equal(find(result, "host agent").status, "ok");
});

test("a missing host agent is a hard failure", async () => {
  const result = await runDoctor({
    cwd: makeRepo(),
    env: {},
    isInstalled: () => false,
  });
  assert.equal(find(result, "host agent").status, "fail");
  assert.equal(result.exitCode, 1);
  assert.match(find(result, "host agent").detail, /claude/);
});

test("running outside a git repository is a hard failure", async () => {
  const result = await runDoctor({
    cwd: mkdtempSync(join(tmpdir(), "ferret-norepo-")),
    env: { FERRET_AGENT_CMD: "fake-agent" },
    isInstalled: () => true,
  });
  assert.equal(find(result, "git repository").status, "fail");
  assert.equal(result.exitCode, 1);
});

test("missing optional analyzers warn but never fail the run", async () => {
  const result = await runDoctor({
    cwd: makeRepo(),
    env: { FERRET_AGENT_CMD: "fake-agent" },
    isInstalled: (cmd) => cmd !== "eslint" && cmd !== "ruff" && cmd !== "semgrep",
  });
  assert.equal(find(result, "analyzers").status, "warn");
  assert.equal(result.exitCode, 0);
});

test("every documented check is reported", async () => {
  const result = await runDoctor({
    cwd: makeRepo(),
    env: { FERRET_AGENT_CMD: "fake-agent" },
    isInstalled: () => true,
  });
  const names = result.checks.map((c) => c.name);
  for (const expected of [
    "node runtime", "git repository", "ferret storage",
    "bash", "python3", "host agent", "codeferret scripts", "analyzers",
  ]) {
    assert.ok(names.includes(expected), `missing check: ${expected}`);
  }
});

test("formatDoctor marks failures and summarizes", async () => {
  const result = await runDoctor({ cwd: makeRepo(), env: {}, isInstalled: () => false });
  const out = formatDoctor(result);
  assert.match(out, /FAIL/);
  assert.match(out, /host agent/);
});
