import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveScope, ScopeError } from "../src/scope.js";

test("no scope flags resolves to the union target", () => {
  assert.deepEqual(resolveScope({}, { defaultBase: "main" }), {
    target: "all",
    includeUntracked: false,
    baseRef: "main",
  });
});

test("--include-untracked sets the flag without changing the target", () => {
  const scope = resolveScope({ includeUntracked: true }, { defaultBase: "main" });
  assert.equal(scope.target, "all");
  assert.equal(scope.includeUntracked, true);
});

test("--committed resolves to the base ref and never includes untracked", () => {
  const scope = resolveScope({ committed: true }, { defaultBase: "develop" });
  assert.deepEqual(scope, { target: "develop", includeUntracked: false, baseRef: "develop" });
});

test("--uncommitted resolves to the uncommitted target with no base ref", () => {
  assert.deepEqual(resolveScope({ uncommitted: true }, { defaultBase: "main" }), {
    target: "uncommitted",
    includeUntracked: false,
    baseRef: null,
  });
});

test("--uncommitted combines with --include-untracked", () => {
  const scope = resolveScope({ uncommitted: true, includeUntracked: true }, {});
  assert.equal(scope.target, "uncommitted");
  assert.equal(scope.includeUntracked, true);
});

test("--base overrides the default base", () => {
  assert.equal(resolveScope({ base: "release" }, { defaultBase: "main" }).baseRef, "release");
});

test("--base-commit takes precedence over --base is rejected as a conflict", () => {
  assert.throws(() => resolveScope({ base: "main", baseCommit: "abc123" }, {}), ScopeError);
});

test("--committed with --uncommitted is rejected", () => {
  assert.throws(() => resolveScope({ committed: true, uncommitted: true }, {}), ScopeError);
});

test("--committed with --include-untracked is rejected", () => {
  assert.throws(
    () => resolveScope({ committed: true, includeUntracked: true }, {}),
    ScopeError,
  );
});

test("--base-commit alone resolves to that commit", () => {
  const scope = resolveScope({ committed: true, baseCommit: "abc123" }, { defaultBase: "main" });
  assert.equal(scope.target, "abc123");
  assert.equal(scope.baseRef, "abc123");
});
