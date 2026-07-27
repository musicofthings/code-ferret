import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ferretRoot, scriptPath, repoRoot, ferretDir } from "../src/paths.js";

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "ferret-paths-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

test("ferretRoot finds the checkout containing scripts/collect-context.sh", () => {
  assert.ok(scriptPath("collect-context.sh").endsWith("collect-context.sh"));
  assert.ok(ferretRoot().length > 0);
});

test("CODEFERRET_ROOT override wins when it contains the scripts dir", () => {
  const fake = mkdtempSync(join(tmpdir(), "ferret-override-"));
  mkdirSync(join(fake, "scripts"), { recursive: true });
  writeFileSync(join(fake, "scripts", "collect-context.sh"), "#!/usr/bin/env bash\n");
  const prev = process.env.CODEFERRET_ROOT;
  process.env.CODEFERRET_ROOT = fake;
  try {
    assert.equal(ferretRoot(), fake);
  } finally {
    if (prev === undefined) delete process.env.CODEFERRET_ROOT;
    else process.env.CODEFERRET_ROOT = prev;
  }
});

test("repoRoot returns the git toplevel inside a repo", () => {
  const dir = makeRepo();
  assert.ok(repoRoot(dir) !== null);
  assert.ok(ferretDir(dir).endsWith(".ferret"));
});

test("repoRoot returns null outside a repo", () => {
  const dir = mkdtempSync(join(tmpdir(), "ferret-norepo-"));
  assert.equal(repoRoot(dir), null);
  assert.equal(ferretDir(dir), null);
});

test("repoRoot from nested subdirectory returns the same toplevel", () => {
  const dir = makeRepo();
  const sub = join(dir, "src", "nested");
  mkdirSync(sub, { recursive: true });
  assert.equal(repoRoot(sub), repoRoot(dir));
  assert.equal(ferretDir(sub), join(repoRoot(dir), ".ferret"));
});
