# CodeFerret CLI (CodeRabbit feature port) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a `ferret` CLI that gives CodeFerret the CodeRabbit CLI experience — terminal-invocable reviews, `--agent` JSONL output, diagnostics, and review history — by delegating semantic analysis to an already-installed coding agent instead of a hosted service.

**Architecture:** A new dependency-free Node ESM package at `cli/` spawns a detected host agent (`claude` / `codex` / `gemini`) with the CodeFerret review prompt. The agent's stdout is treated as opaque progress text; structured findings are read back from `.ferret/last-review.json`, the file the existing review methodology already writes. Scope flags resolve to `collect-context.sh` targets, two of which are new.

**Tech Stack:** Node ≥20 ESM (`node:util.parseArgs`, `node:test`, `node:assert/strict`), bash (`collect-context.sh`), python3 (existing `fp_cache.py` / `run_tools.py`). No runtime dependencies.

## Global Constraints

- **Zero runtime dependencies in `cli/`.** Flags use `node:util.parseArgs`; tests use `node --test` with `node:assert/strict`. Do not add npm packages.
- **Node ≥20** (`parseArgs` stability floor). Declare `"engines": { "node": ">=20" }`.
- **Agent invocation is never live in tests.** `FERRET_AGENT_CMD` points at a fixture script. No test may make a network call or spend model budget.
- **`head` and `staged` targets keep their exact current semantics**, including `head`'s always-on untracked inclusion. `/code-ferret:review` behavior must not change.
- **Severity is 3-tier internally** (`CRITICAL`/`WARNING`/`SUGGESTION`). Only `--agent` wire output maps to CodeRabbit names. `trivial` and `info` are never emitted.
- **`collect-context.sh` positional interface stays backward compatible.** New behavior is driven by environment variables (`FERRET_BASE_REF`, `FERRET_INCLUDE_UNTRACKED`, `FERRET_LIGHT`), never new positional arguments.
- **Never echo credential values.** Secret locations only, per existing project rule.
- Branch: `feat/coderabbit-cli-port`. Commit after every task.

---

### Task 1: CLI package scaffold and path resolution

**Files:**
- Create: `cli/package.json`
- Create: `cli/bin/ferret.js`
- Create: `cli/src/paths.js`
- Test: `cli/test/paths.test.js`

**Interfaces:**
- Consumes: nothing (first task)
- Produces:
  - `ferretRoot(): string` — CodeFerret installation root
  - `scriptPath(name: string): string` — absolute path to `scripts/<name>`
  - `repoRoot(cwd: string): string | null` — git toplevel, or `null` when not a repo
  - `ferretDir(cwd: string): string | null` — `<repoRoot>/.ferret`, or `null`

- [ ] **Step 1: Write the failing test**

Create `cli/test/paths.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd cli && node --test test/paths.test.js`
Expected: FAIL — `Cannot find module '../src/paths.js'`

- [ ] **Step 3: Write `cli/package.json`**

```json
{
  "name": "code-ferret-cli",
  "version": "0.3.0",
  "description": "CodeFerret CLI — diff-scoped semantic code review driven by your installed coding agent.",
  "type": "module",
  "bin": {
    "ferret": "bin/ferret.js",
    "code-ferret": "bin/ferret.js"
  },
  "scripts": {
    "test": "node --test test/"
  },
  "engines": {
    "node": ">=20"
  },
  "files": ["bin", "src"]
}
```

- [ ] **Step 4: Write `cli/src/paths.js`**

```js
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SRC_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Locate the CodeFerret installation, in priority order:
 * 1. CODEFERRET_ROOT env override, 2. the repo checkout this CLI lives in,
 * 3. a vendored copy next to the CLI. Mirrors mcp-server/server/index.js.
 */
export function ferretRoot() {
  const override = process.env.CODEFERRET_ROOT;
  if (override && existsSync(join(override, "scripts", "collect-context.sh"))) {
    return override;
  }
  const checkout = resolve(SRC_DIR, "..", "..");
  if (existsSync(join(checkout, "scripts", "collect-context.sh"))) return checkout;
  return resolve(SRC_DIR, "..", "vendor");
}

export function scriptPath(name) {
  return join(ferretRoot(), "scripts", name);
}

export function repoRoot(cwd) {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

export function ferretDir(cwd) {
  const root = repoRoot(cwd);
  return root ? join(root, ".ferret") : null;
}
```

- [ ] **Step 5: Write `cli/bin/ferret.js`**

```js
#!/usr/bin/env node
import { main } from "../src/index.js";

process.exitCode = await main(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
  env: process.env,
  cwd: process.cwd(),
});
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd cli && node --test test/paths.test.js`
Expected: PASS, 4 tests. (`bin/ferret.js` is not executed yet — `src/index.js` arrives in Task 9.)

- [ ] **Step 7: Commit**

```bash
git add cli/package.json cli/bin/ferret.js cli/src/paths.js cli/test/paths.test.js
git commit -m "feat(cli): scaffold CLI package with path resolution"
```

---

### Task 2: Scope flag resolution

**Files:**
- Create: `cli/src/scope.js`
- Test: `cli/test/scope.test.js`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `class ScopeError extends Error`
  - `resolveScope(flags, options): { target, includeUntracked, baseRef }`
    - `flags`: `{ committed?, uncommitted?, includeUntracked?, base?, baseCommit? }`
    - `options`: `{ defaultBase?: string }` (default `"main"`)
    - `target`: `"all"` | `"uncommitted"` | a base ref string

- [ ] **Step 1: Write the failing test**

Create `cli/test/scope.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd cli && node --test test/scope.test.js`
Expected: FAIL — `Cannot find module '../src/scope.js'`

- [ ] **Step 3: Write `cli/src/scope.js`**

```js
/** Raised for contradictory scope flags. Rejected before any review starts. */
export class ScopeError extends Error {
  constructor(message) {
    super(message);
    this.name = "ScopeError";
  }
}

/**
 * Resolve CLI scope flags to a collect-context.sh target.
 *
 * Targets: "all" (committed + staged + unstaged, i.e. base..worktree),
 * "uncommitted" (staged + unstaged tracked only), or a base ref string
 * (committed only, base...HEAD).
 */
export function resolveScope(flags = {}, options = {}) {
  const {
    committed = false,
    uncommitted = false,
    includeUntracked = false,
    base = null,
    baseCommit = null,
  } = flags;
  const { defaultBase = "main" } = options;

  if (committed && uncommitted) {
    throw new ScopeError("--committed cannot be combined with --uncommitted");
  }
  if (committed && includeUntracked) {
    throw new ScopeError("--committed cannot be combined with --include-untracked");
  }
  if (base && baseCommit) {
    throw new ScopeError("--base cannot be combined with --base-commit");
  }

  const baseRef = baseCommit || base || defaultBase;

  if (committed) return { target: baseRef, includeUntracked: false, baseRef };
  if (uncommitted) return { target: "uncommitted", includeUntracked, baseRef: null };
  return { target: "all", includeUntracked, baseRef };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd cli && node --test test/scope.test.js`
Expected: PASS, 10 tests

- [ ] **Step 5: Commit**

```bash
git add cli/src/scope.js cli/test/scope.test.js
git commit -m "feat(cli): resolve scope flags with conflict rejection"
```

---

### Task 3: `collect-context.sh` gains `all`, `uncommitted`, untracked gating, and light mode

**Files:**
- Modify: `scripts/collect-context.sh:8-47` (mode dispatch and untracked collection), `:91-99` (history and diff emission)
- Modify: `tests/run.sh:29-46` (add cases after the existing `head` assertions)

**Interfaces:**
- Consumes: nothing
- Produces: `collect-context.sh` accepts modes `all` and `uncommitted` in addition to `staged`, `head`, `<base-ref>`, and honors three environment variables:
  - `FERRET_BASE_REF` — base ref for `all` mode (default `main`)
  - `FERRET_INCLUDE_UNTRACKED=1` — force untracked inclusion for any mode
  - `FERRET_LIGHT=1` — `-U10` context and skip `FERRET_FILE_HISTORY`

- [ ] **Step 1: Write the failing test**

Append to `tests/run.sh`, immediately after line 35 (`assert_contains "$CONTEXT" "Check database migrations for rollback safety."`):

```bash
# --- new scope modes -------------------------------------------------------
printf 'tracked edit\n' >> "$REPO/app.txt"

UNCOMMITTED="$(cd "$REPO" && bash "$ROOT/scripts/collect-context.sh" uncommitted)"
assert_contains "$UNCOMMITTED" "mode: uncommitted"
assert_contains "$UNCOMMITTED" "+++ b/app.txt"
[[ "$UNCOMMITTED" != *"+++ b/fresh.ts"* ]] || fail "uncommitted must exclude untracked files"

UNCOMMITTED_UT="$(cd "$REPO" && FERRET_INCLUDE_UNTRACKED=1 bash "$ROOT/scripts/collect-context.sh" uncommitted)"
assert_contains "$UNCOMMITTED_UT" "+++ b/fresh.ts"

BASE_BRANCH="$(git -C "$REPO" rev-parse --abbrev-ref HEAD)"
git -C "$REPO" checkout -q -b feature
printf 'committed change\n' > "$REPO/committed.txt"
git -C "$REPO" add committed.txt
git -C "$REPO" commit -qm "committed change"

ALL="$(cd "$REPO" && FERRET_BASE_REF="$BASE_BRANCH" bash "$ROOT/scripts/collect-context.sh" all)"
assert_contains "$ALL" "mode: all"
assert_contains "$ALL" "+++ b/committed.txt"
assert_contains "$ALL" "+++ b/app.txt"

LIGHT="$(cd "$REPO" && bash "$ROOT/scripts/collect-context.sh" uncommitted)"
LIGHT_ON="$(cd "$REPO" && FERRET_LIGHT=1 bash "$ROOT/scripts/collect-context.sh" uncommitted)"
assert_contains "$LIGHT" "=== FERRET_FILE_HISTORY ==="
assert_contains "$LIGHT_ON" "(skipped: light mode)"
[[ "${#LIGHT_ON}" -lt "${#LIGHT}" ]] || fail "light mode should emit less context"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash tests/run.sh`
Expected: FAIL — `unknown base ref: uncommitted` (the mode dispatch rejects it)

- [ ] **Step 3: Add the new modes to `scripts/collect-context.sh`**

Replace lines 8-26 (from `MODE="${1:-head}"` through the closing `esac`) with:

```bash
MODE="${1:-head}"
BASE_REF="${FERRET_BASE_REF:-main}"
LIGHT="${FERRET_LIGHT:-0}"
CONTEXT_LINES=50
[[ "$LIGHT" == "1" ]] && CONTEXT_LINES=10

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "error: not inside a git repository" >&2
  exit 1
}
cd "$REPO_ROOT"

DIFF_ARGS=()
case "$MODE" in
  staged)      DIFF_ARGS=(--cached) ;;
  head)        DIFF_ARGS=(HEAD) ;;
  uncommitted) DIFF_ARGS=(HEAD) ;;
  all)
    if ! git rev-parse --verify "${BASE_REF}^{commit}" >/dev/null 2>&1; then
      echo "error: unknown base ref: $BASE_REF" >&2
      exit 2
    fi
    DIFF_ARGS=("$BASE_REF")
    ;;
  *)
    if ! git rev-parse --verify "${MODE}^{commit}" >/dev/null 2>&1; then
      echo "error: unknown base ref: $MODE" >&2
      exit 2
    fi
    DIFF_ARGS=("$MODE"...HEAD)
    ;;
esac
```

Note: the original `REPO_ROOT` block moves above `DIFF_ARGS` so `all` can validate its base ref from inside the repo.

- [ ] **Step 4: Gate untracked collection**

Replace lines 38-47 of the original file (the `UNTRACKED=()` block) with:

```bash
INCLUDE_UNTRACKED=0
[[ "$MODE" == "head" ]] && INCLUDE_UNTRACKED=1
[[ "${FERRET_INCLUDE_UNTRACKED:-0}" == "1" ]] && INCLUDE_UNTRACKED=1

UNTRACKED=()
if [[ "$INCLUDE_UNTRACKED" == "1" ]]; then
  UNTRACKED_ARGS=(--others --exclude-standard -z)
  if [[ -f .ferretignore ]]; then
    UNTRACKED_ARGS+=(--exclude-from=.ferretignore)
  fi
  while IFS= read -r -d '' file; do
    UNTRACKED+=("$file")
  done < <(git ls-files "${UNTRACKED_ARGS[@]}")
fi
```

- [ ] **Step 5: Apply light mode to history and diff emission**

Replace the `FERRET_FILE_HISTORY` block (original lines 91-96) with:

```bash
echo "=== FERRET_FILE_HISTORY ==="
if [[ "$LIGHT" == "1" ]]; then
  echo "(skipped: light mode)"
else
  git diff "${DIFF_ARGS[@]}" --name-only -- . "${EXCLUDES[@]+"${EXCLUDES[@]}"}" | while IFS= read -r f; do
    [[ -z "$f" ]] && continue
    echo "--- $f"
    git log --oneline -n 5 --follow -- "$f" 2>/dev/null || echo "(no history)"
  done
fi
```

Then replace the two hardcoded `-U50` occurrences (original lines 99 and 101) with `-U"$CONTEXT_LINES"`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `bash tests/run.sh`
Expected: PASS — `CodeFerret shell integration tests passed.`

- [ ] **Step 7: Commit**

```bash
git add scripts/collect-context.sh tests/run.sh
git commit -m "feat(context): add all/uncommitted modes, untracked gating, light mode"
```

---

### Task 4: JSONL event emitter and wire-format mapping

**Files:**
- Create: `cli/src/events.js`
- Test: `cli/test/events.test.js`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `mapSeverity(severity: string): "critical" | "major" | "minor"`
  - `toWireFinding(finding: object): object` — CodeRabbit-shaped `finding` event
  - `createEmitter({ agent: boolean, stdout: Writable }): Emitter` with methods `reviewContext(ctx)`, `status(s)`, `heartbeat()`, `finding(f)`, `complete(obj)`, `error(obj)`
  - `emitNoChanges(emitter, ctx): void` — the documented empty-diff sequence

- [ ] **Step 1: Write the failing test**

Create `cli/test/events.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mapSeverity, toWireFinding, createEmitter, emitNoChanges } from "../src/events.js";

function capture() {
  const lines = [];
  return {
    stdout: { write: (s) => lines.push(s) },
    events: () => lines.join("").trimEnd().split("\n").filter(Boolean).map((l) => JSON.parse(l)),
  };
}

test("severity maps the 3-tier taxonomy onto CodeRabbit names", () => {
  assert.equal(mapSeverity("CRITICAL"), "critical");
  assert.equal(mapSeverity("WARNING"), "major");
  assert.equal(mapSeverity("SUGGESTION"), "minor");
  assert.equal(mapSeverity("unknown"), "minor");
});

test("toWireFinding maps CodeFerret fields onto the wire contract", () => {
  const wire = toWireFinding({
    file: "src/pay.ts",
    line: 84,
    character: 14,
    severity: "CRITICAL",
    vector: "CONCURRENCY",
    confidence: "HIGH",
    message: "Race condition during balance debit.",
    explanation: "Two concurrent debits read the same balance.",
    codegen_instructions: "Wrap the read-modify-write in a transaction.",
    patch: "--- a/src/pay.ts\n+++ b/src/pay.ts\n",
  });
  assert.equal(wire.type, "finding");
  assert.equal(wire.severity, "critical");
  assert.equal(wire.fileName, "src/pay.ts");
  assert.equal(wire.codegenInstructions, "Wrap the read-modify-write in a transaction.");
  assert.deepEqual(wire.suggestions, ["--- a/src/pay.ts\n+++ b/src/pay.ts\n"]);
  assert.equal(wire.comment, "Race condition during balance debit.");
  assert.equal(wire.vector, "CONCURRENCY");
  assert.equal(wire.confidence, "HIGH");
});

test("codegenInstructions falls back to explanation, suggestions to empty", () => {
  const wire = toWireFinding({
    file: "a.ts",
    severity: "WARNING",
    message: "m",
    explanation: "why it breaks",
    patch: null,
  });
  assert.equal(wire.codegenInstructions, "why it breaks");
  assert.deepEqual(wire.suggestions, []);
});

test("emitter writes one JSON object per line in agent mode", () => {
  const cap = capture();
  const e = createEmitter({ agent: true, stdout: cap.stdout });
  e.reviewContext({ target: "all", branch: "main", files: 2, agent: "claude" });
  e.status("collecting_context");
  e.heartbeat();
  e.complete({ status: "completed", findings: 0, suppressed: 0, deduped: 0 });
  const events = cap.events();
  assert.deepEqual(events.map((x) => x.type), [
    "review_context", "status", "heartbeat", "complete",
  ]);
  assert.equal(events[0].target, "all");
  assert.ok(events[2].ts);
});

test("emitter writes nothing in plain mode", () => {
  const cap = capture();
  const e = createEmitter({ agent: false, stdout: cap.stdout });
  e.status("collecting_context");
  e.complete({ status: "completed", findings: 0 });
  assert.deepEqual(cap.events(), []);
});

test("emitNoChanges emits the documented empty-diff sequence", () => {
  const cap = capture();
  const e = createEmitter({ agent: true, stdout: cap.stdout });
  emitNoChanges(e, { target: "all", branch: "main", files: 0, agent: "claude" });
  const events = cap.events();
  assert.deepEqual(events.map((x) => x.type), ["review_context", "status", "complete"]);
  assert.equal(events[1].status, "review_skipped");
  assert.equal(events[2].status, "review_skipped");
  assert.equal(events[2].findings, 0);
  assert.equal(events[2].message, "No changes detected");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd cli && node --test test/events.test.js`
Expected: FAIL — `Cannot find module '../src/events.js'`

- [ ] **Step 3: Write `cli/src/events.js`**

```js
const SEVERITY_MAP = {
  CRITICAL: "critical",
  WARNING: "major",
  SUGGESTION: "minor",
};

/**
 * Map CodeFerret's authoritative 3-tier severity onto CodeRabbit's wire names.
 * Lossy by design: "trivial" and "info" are never emitted.
 */
export function mapSeverity(severity) {
  return SEVERITY_MAP[String(severity).toUpperCase()] ?? "minor";
}

/** Convert a .ferret/last-review.json finding to a CodeRabbit-shaped event. */
export function toWireFinding(finding) {
  return {
    type: "finding",
    severity: mapSeverity(finding.severity),
    fileName: finding.file,
    line: finding.line ?? null,
    character: finding.character ?? null,
    codegenInstructions: finding.codegen_instructions || finding.explanation || "",
    suggestions: finding.patch ? [finding.patch] : [],
    comment: finding.message,
    vector: finding.vector,
    confidence: finding.confidence,
  };
}

/**
 * JSONL emitter. In plain mode every method is a no-op — the human-readable
 * report is produced separately by report.js.
 */
export function createEmitter({ agent = false, stdout = process.stdout } = {}) {
  const write = (obj) => {
    if (agent) stdout.write(`${JSON.stringify(obj)}\n`);
  };
  return {
    agent,
    reviewContext(ctx) { write({ type: "review_context", ...ctx }); },
    status(status) { write({ type: "status", status }); },
    heartbeat() { write({ type: "heartbeat", ts: new Date().toISOString() }); },
    finding(finding) { write(toWireFinding(finding)); },
    complete(result) { write({ type: "complete", ...result }); },
    error(err) { write({ type: "error", ...err }); },
  };
}

/** The documented empty-diff sequence: context, review_skipped, complete. */
export function emitNoChanges(emitter, context) {
  emitter.reviewContext(context);
  emitter.status("review_skipped");
  emitter.complete({
    status: "review_skipped",
    findings: 0,
    message: "No changes detected",
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd cli && node --test test/events.test.js`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add cli/src/events.js cli/test/events.test.js
git commit -m "feat(cli): add JSONL emitter and CodeRabbit wire mapping"
```

---

### Task 5: Findings reader and plain-text report

**Files:**
- Create: `cli/src/findings.js`
- Create: `cli/src/report.js`
- Test: `cli/test/findings.test.js`
- Test: `cli/test/report.test.js`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `readReview(ferretDir): Promise<object | null>` — parsed `last-review.json`, `null` when absent or malformed
  - `readPrompts(ferretDir): Promise<object | null>` — parsed `last-prompts.json`
  - `sortFindings(findings: array): array` — CRITICAL → WARNING → SUGGESTION, HIGH confidence first within a tier
  - `formatFinding(finding): string`
  - `formatReport(review, tally): string` — `tally` is `{ suppressed, deduped }`
  - `formatCandidates(candidates, note): string`

- [ ] **Step 1: Write the failing tests**

Create `cli/test/findings.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readReview, readPrompts, sortFindings } from "../src/findings.js";

function ferretDirWith(files) {
  const dir = join(mkdtempSync(join(tmpdir(), "ferret-find-")), ".ferret");
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), body);
  }
  return dir;
}

test("readReview parses last-review.json", async () => {
  const dir = ferretDirWith({
    "last-review.json": JSON.stringify({ target: "all", findings: [{ id: "f1" }] }),
  });
  const review = await readReview(dir);
  assert.equal(review.target, "all");
  assert.equal(review.findings.length, 1);
});

test("readReview returns null when the file is missing", async () => {
  assert.equal(await readReview(ferretDirWith({})), null);
});

test("readReview returns null on malformed JSON", async () => {
  assert.equal(await readReview(ferretDirWith({ "last-review.json": "{not json" })), null);
});

test("readPrompts parses last-prompts.json", async () => {
  const dir = ferretDirWith({
    "last-prompts.json": JSON.stringify({ prompts: [{ name: "review", text: "hi" }] }),
  });
  assert.equal((await readPrompts(dir)).prompts[0].name, "review");
});

test("sortFindings orders by severity then confidence", () => {
  const sorted = sortFindings([
    { id: "a", severity: "SUGGESTION", confidence: "HIGH" },
    { id: "b", severity: "CRITICAL", confidence: "MEDIUM" },
    { id: "c", severity: "CRITICAL", confidence: "HIGH" },
    { id: "d", severity: "WARNING", confidence: "LOW" },
  ]);
  assert.deepEqual(sorted.map((f) => f.id), ["c", "b", "d", "a"]);
});
```

Create `cli/test/report.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatFinding, formatReport, formatCandidates } from "../src/report.js";

const FINDING = {
  file: "src/pay.ts",
  line: 84,
  character: 14,
  severity: "CRITICAL",
  vector: "CONCURRENCY",
  confidence: "HIGH",
  message: "Race condition during balance debit.",
  explanation: "Two concurrent debits read the same balance.",
  patch: "--- a/src/pay.ts\n",
};

test("formatFinding emits a clickable file:line:col header", () => {
  const out = formatFinding(FINDING);
  assert.match(out, /\[CRITICAL · CONCURRENCY · HIGH\] src\/pay\.ts:84:14/);
  assert.match(out, /Race condition during balance debit\./);
  assert.match(out, /Two concurrent debits read the same balance\./);
  assert.match(out, /Fix available/);
});

test("formatFinding omits the fix line when there is no patch", () => {
  assert.doesNotMatch(formatFinding({ ...FINDING, patch: null }), /Fix available/);
});

test("formatFinding defaults a missing character to 1", () => {
  assert.match(formatFinding({ ...FINDING, character: undefined }), /src\/pay\.ts:84:1\b/);
});

test("formatReport closes with an honest tally", () => {
  const out = formatReport(
    { target: "all", findings: [FINDING, { ...FINDING, severity: "WARNING" }] },
    { suppressed: 4, deduped: 2 },
  );
  assert.match(out, /1 critical · 1 warning · 0 suggestions/);
  assert.match(out, /4 suppressed by cache/);
  assert.match(out, /2 deduped/);
});

test("formatReport reports a clean run", () => {
  const out = formatReport({ target: "all", findings: [] }, { suppressed: 0, deduped: 0 });
  assert.match(out, /0 critical · 0 warning · 0 suggestions/);
});

test("formatCandidates lists commands with counts and fit indicators", () => {
  const out = formatCandidates(
    [
      { command: "ferret review --committed", files: 12, fits: true },
      { command: "ferret review --dir src/api", files: 61, fits: false },
    ],
    "Choose one and rerun manually.",
  );
  assert.match(out, /Narrower scopes found in this diff/);
  assert.match(out, /ferret review --committed/);
  assert.match(out, /12 files/);
  assert.match(out, /over limit/);
  assert.match(out, /Choose one and rerun manually\./);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd cli && node --test test/findings.test.js test/report.test.js`
Expected: FAIL — `Cannot find module '../src/findings.js'`

- [ ] **Step 3: Write `cli/src/findings.js`**

```js
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const SEVERITY_ORDER = { CRITICAL: 0, WARNING: 1, SUGGESTION: 2 };
const CONFIDENCE_ORDER = { HIGH: 0, MEDIUM: 1, LOW: 2 };

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

/** Read the findings the host agent wrote. This is the CLI's real contract. */
export function readReview(ferretDir) {
  return readJson(join(ferretDir, "last-review.json"));
}

export function readPrompts(ferretDir) {
  return readJson(join(ferretDir, "last-prompts.json"));
}

/** CRITICAL → WARNING → SUGGESTION, HIGH confidence first within a tier. */
export function sortFindings(findings) {
  return [...findings].sort((a, b) => {
    const sev = (SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3);
    if (sev !== 0) return sev;
    return (CONFIDENCE_ORDER[a.confidence] ?? 3) - (CONFIDENCE_ORDER[b.confidence] ?? 3);
  });
}
```

- [ ] **Step 4: Write `cli/src/report.js`**

```js
import { sortFindings } from "./findings.js";

export function formatFinding(finding) {
  const loc = `${finding.file}:${finding.line ?? 1}:${finding.character ?? 1}`;
  const head = `[${finding.severity} · ${finding.vector} · ${finding.confidence}] ${loc}`;
  const lines = [head, `  ${finding.message}`];
  if (finding.explanation) lines.push(`  ${finding.explanation}`);
  if (finding.patch) lines.push("  Fix available — run /code-ferret:triage to apply.");
  return lines.join("\n");
}

export function formatReport(review, tally = {}) {
  const { suppressed = 0, deduped = 0 } = tally;
  const findings = sortFindings(review.findings ?? []);
  const counts = { CRITICAL: 0, WARNING: 0, SUGGESTION: 0 };
  for (const f of findings) {
    if (counts[f.severity] !== undefined) counts[f.severity] += 1;
  }
  const body = findings.map(formatFinding).join("\n\n");
  const tallyLine =
    `${counts.CRITICAL} critical · ${counts.WARNING} warning · ` +
    `${counts.SUGGESTION} suggestions ` +
    `(${suppressed} suppressed by cache, ${deduped} deduped)`;
  return body ? `${body}\n\n${tallyLine}` : tallyLine;
}

export function formatCandidates(candidates, note) {
  const lines = ["Narrower scopes found in this diff:", ""];
  for (const c of candidates) {
    const fit = c.fits ? "fits" : "over limit";
    lines.push(`  ${c.command}`);
    lines.push(`    ~${c.files} files (${fit})`);
  }
  lines.push("", note);
  return lines.join("\n");
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd cli && node --test test/findings.test.js test/report.test.js`
Expected: PASS, 11 tests

- [ ] **Step 6: Commit**

```bash
git add cli/src/findings.js cli/src/report.js cli/test/findings.test.js cli/test/report.test.js
git commit -m "feat(cli): read findings and render the plain-text report"
```

---

### Task 6: Oversized-diff candidate computation

**Files:**
- Create: `cli/src/candidates.js`
- Test: `cli/test/candidates.test.js`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `topDirectories(files: string[]): Array<[string, number]>` — descending by count, then path
  - `computeCandidates({ files, maxFiles, committedFiles, uncommittedFiles }): { candidates, candidatesNote }`
    - each candidate: `{ command: string, files: number, fits: boolean }`, at most 5

- [ ] **Step 1: Write the failing test**

Create `cli/test/candidates.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeCandidates, topDirectories } from "../src/candidates.js";

test("topDirectories counts by parent directory, descending", () => {
  const dirs = topDirectories(["src/a.ts", "src/b.ts", "web/c.ts", "root.ts"]);
  assert.deepEqual(dirs, [["src", 2], [".", 1], ["web", 1]]);
});

test("computeCandidates offers committed and uncommitted scopes first", () => {
  const { candidates } = computeCandidates({
    files: Array.from({ length: 60 }, (_, i) => `src/f${i}.ts`),
    maxFiles: 50,
    committedFiles: ["src/a.ts"],
    uncommittedFiles: ["src/b.ts", "src/c.ts"],
  });
  assert.equal(candidates[0].command, "ferret review --committed");
  assert.equal(candidates[0].files, 1);
  assert.equal(candidates[0].fits, true);
  assert.equal(candidates[1].command, "ferret review --uncommitted");
  assert.equal(candidates[1].files, 2);
});

test("computeCandidates falls back to --dir scopes and caps at five", () => {
  const files = [];
  for (const dir of ["a", "b", "c", "d", "e", "f", "g"]) {
    for (let i = 0; i < 10; i += 1) files.push(`${dir}/f${i}.ts`);
  }
  const { candidates } = computeCandidates({ files, maxFiles: 50 });
  assert.equal(candidates.length, 5);
  assert.ok(candidates.every((c) => c.command.startsWith("ferret review --dir ")));
});

test("candidates carry a conservative fit indicator", () => {
  const { candidates } = computeCandidates({
    files: Array.from({ length: 60 }, (_, i) => `src/f${i}.ts`),
    maxFiles: 50,
  });
  assert.equal(candidates[0].fits, false);
  assert.equal(candidates[0].files, 60);
});

test("candidatesNote names the file count and the limit", () => {
  const { candidatesNote } = computeCandidates({
    files: Array.from({ length: 61 }, (_, i) => `src/f${i}.ts`),
    maxFiles: 50,
  });
  assert.match(candidatesNote, /61/);
  assert.match(candidatesNote, /50/);
  assert.match(candidatesNote, /rerun/i);
});

test("empty scopes are not offered as candidates", () => {
  const { candidates } = computeCandidates({
    files: ["a/x.ts"],
    maxFiles: 50,
    committedFiles: [],
    uncommittedFiles: [],
  });
  assert.ok(candidates.every((c) => !c.command.includes("--committed")));
  assert.ok(candidates.every((c) => !c.command.includes("--uncommitted")));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd cli && node --test test/candidates.test.js`
Expected: FAIL — `Cannot find module '../src/candidates.js'`

- [ ] **Step 3: Write `cli/src/candidates.js`**

```js
const MAX_CANDIDATES = 5;

/** Count changed files per parent directory, most-changed first. */
export function topDirectories(files) {
  const counts = new Map();
  for (const file of files) {
    const slash = file.lastIndexOf("/");
    const dir = slash === -1 ? "." : file.slice(0, slash);
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }
  return [...counts.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  );
}

/**
 * Suggest mutually exclusive narrower re-run commands for an oversized diff.
 * The CLI never selects one, splits the review, or retries — the user does.
 * Estimates are deliberately conservative.
 */
export function computeCandidates({
  files,
  maxFiles,
  committedFiles = [],
  uncommittedFiles = [],
}) {
  const candidates = [];
  if (committedFiles.length > 0) {
    candidates.push({
      command: "ferret review --committed",
      files: committedFiles.length,
      fits: committedFiles.length <= maxFiles,
    });
  }
  if (uncommittedFiles.length > 0) {
    candidates.push({
      command: "ferret review --uncommitted",
      files: uncommittedFiles.length,
      fits: uncommittedFiles.length <= maxFiles,
    });
  }
  for (const [dir, count] of topDirectories(files)) {
    if (candidates.length >= MAX_CANDIDATES) break;
    candidates.push({
      command: `ferret review --dir ${dir}`,
      files: count,
      fits: count <= maxFiles,
    });
  }
  return {
    candidates: candidates.slice(0, MAX_CANDIDATES),
    candidatesNote:
      `The selected scope contains ${files.length} files, above the ` +
      `${maxFiles}-file limit. Choose one narrower scope and rerun it ` +
      `manually. Estimates are conservative — a candidate marked over the ` +
      `limit may still fit after filtering.`,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd cli && node --test test/candidates.test.js`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add cli/src/candidates.js cli/test/candidates.test.js
git commit -m "feat(cli): compute narrower-scope candidates for oversized diffs"
```

---

### Task 7: Host-agent detection and invocation

**Files:**
- Create: `cli/src/agent.js`
- Create: `cli/test/fixtures/fake-agent.js`
- Test: `cli/test/agent.test.js`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `AGENTS: Array<{ name, cmd, args(prompt): string[] }>`
  - `detectAgent({ env, isInstalled }): { name, cmd, args } | null`
  - `runAgent({ agent, prompt, cwd, onLine, timeoutMs }): Promise<{ exitCode, stderr }>`
  - `CLAUDE_ALLOWED_TOOLS: string` — the scoped permission allowlist

- [ ] **Step 1: Write the failing test**

Create `cli/test/fixtures/fake-agent.js`:

```js
#!/usr/bin/env node
// Test double for a host coding agent. Emits progress lines, then writes the
// canned findings file the real agent's methodology would produce.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

process.stdout.write("collecting context\n");
process.stdout.write("running analyzers\n");

if (process.env.FAKE_AGENT_FAIL === "1") {
  process.stderr.write("simulated agent failure\n");
  process.exit(3);
}

const dir = join(process.cwd(), ".ferret");
mkdirSync(dir, { recursive: true });
writeFileSync(
  join(dir, "last-review.json"),
  JSON.stringify({
    generated_at: new Date().toISOString(),
    target: process.env.FAKE_AGENT_TARGET ?? "all",
    findings: [
      {
        id: "f1",
        file: "src/pay.ts",
        line: 84,
        character: 14,
        severity: "CRITICAL",
        vector: "CONCURRENCY",
        confidence: "HIGH",
        message: "Race condition during balance debit.",
        explanation: "Two concurrent debits read the same balance.",
        codegen_instructions: "Wrap the read-modify-write in a transaction.",
        patch: null,
        suppression_hash: "deadbeefdeadbeef",
      },
    ],
  }),
);
process.exit(0);
```

Create `cli/test/agent.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { detectAgent, runAgent, AGENTS, CLAUDE_ALLOWED_TOOLS } from "../src/agent.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE = join(HERE, "fixtures", "fake-agent.js");

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd cli && node --test test/agent.test.js`
Expected: FAIL — `Cannot find module '../src/agent.js'`

- [ ] **Step 3: Write `cli/src/agent.js`**

```js
import { spawn, spawnSync } from "node:child_process";

const WIN = process.platform === "win32";

/**
 * Permissions the agent needs to run CodeFerret's own scripts non-interactively.
 * Deliberately scoped — never disable permission checks wholesale.
 */
export const CLAUDE_ALLOWED_TOOLS =
  "Bash(bash:*) Bash(python3:*) Bash(git diff:*) Bash(git log:*) Read Grep Glob Write";

export const AGENTS = [
  {
    name: "claude",
    cmd: "claude",
    args: (prompt) => ["-p", prompt, "--allowedTools", CLAUDE_ALLOWED_TOOLS],
  },
  { name: "codex", cmd: "codex", args: (prompt) => ["exec", prompt] },
  { name: "gemini", cmd: "gemini", args: (prompt) => ["-p", prompt] },
];

function defaultIsInstalled(cmd) {
  const probe = spawnSync(cmd, ["--version"], { stdio: "ignore", shell: WIN });
  return !probe.error;
}

/** Pick the host agent: explicit override first, then first installed. */
export function detectAgent({ env = process.env, isInstalled = defaultIsInstalled } = {}) {
  const override = env.FERRET_AGENT_CMD || env.FERRET_AGENT;
  if (override) {
    return { name: "custom", cmd: override, args: (prompt) => [prompt] };
  }
  for (const agent of AGENTS) {
    if (isInstalled(agent.cmd)) return agent;
  }
  return null;
}

/**
 * Run the host agent. Its stdout is opaque progress text delivered line by line
 * to onLine; findings are read from .ferret/last-review.json afterwards.
 */
export function runAgent({
  agent,
  prompt,
  cwd,
  onLine,
  env = process.env,
  timeoutMs = 30 * 60 * 1000,
}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(agent.cmd, agent.args(prompt), {
        cwd,
        env,
        shell: WIN,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({ exitCode: 1, stderr: err.message });
      return;
    }

    let buffer = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      let index;
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index).replace(/\r$/, "");
        buffer = buffer.slice(index + 1);
        if (line) onLine?.(line);
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (buffer.trim()) onLine?.(buffer.trim());
      resolve({ exitCode: code ?? 1, stderr });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ exitCode: 1, stderr: err.message });
    });
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd cli && node --test test/agent.test.js`
Expected: PASS, 7 tests

- [ ] **Step 5: Commit**

```bash
git add cli/src/agent.js cli/test/agent.test.js cli/test/fixtures/fake-agent.js
git commit -m "feat(cli): detect and invoke the host coding agent"
```

---

### Task 8: Review history and stats

**Files:**
- Create: `cli/src/stats.js`
- Test: `cli/test/stats.test.js`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `appendHistory(ferretDir, entry): Promise<void>` — appends one JSON line to `history.jsonl`, creating `.ferret/` and `.ferret/.gitignore` as needed
  - `readHistory(ferretDir): Promise<object[]>` — skips malformed lines
  - `aggregate(entries): object` — the stats shape
  - `readStats(ferretDir, { rebuild }): Promise<object>` — reads `stats.json`, or recomputes from history when missing or when `rebuild` is true
  - `formatStats(stats): string`
  - `FERRET_GITIGNORE: string` — the generated `.ferret/.gitignore` body

- [ ] **Step 1: Write the failing test**

Create `cli/test/stats.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendHistory, readHistory, aggregate, readStats, formatStats, FERRET_GITIGNORE,
} from "../src/stats.js";

const newDir = () => join(mkdtempSync(join(tmpdir(), "ferret-stats-")), ".ferret");

const ENTRY = {
  ts: "2026-07-27T10:00:00Z",
  target: "all",
  branch: "main",
  commit: "abc1234",
  by_severity: { CRITICAL: 1, WARNING: 2, SUGGESTION: 0 },
  by_vector: { CONCURRENCY: 1, LOGIC: 2 },
  suppressed: 1,
  deduped: 2,
  duration_ms: 4000,
  agent: "claude",
  light: false,
};

test("appendHistory creates .ferret, the gitignore, and one line per review", async () => {
  const dir = newDir();
  await appendHistory(dir, ENTRY);
  await appendHistory(dir, { ...ENTRY, ts: "2026-07-27T11:00:00Z" });
  const raw = readFileSync(join(dir, "history.jsonl"), "utf8").trimEnd().split("\n");
  assert.equal(raw.length, 2);
  assert.equal(JSON.parse(raw[0]).branch, "main");
  assert.ok(existsSync(join(dir, ".gitignore")));
});

test("the generated gitignore keeps review-cache.json shareable", () => {
  assert.match(FERRET_GITIGNORE, /^\*$/m);
  assert.match(FERRET_GITIGNORE, /^!review-cache\.json$/m);
  assert.match(FERRET_GITIGNORE, /^!\.gitignore$/m);
});

test("readHistory skips malformed lines", async () => {
  const dir = newDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "history.jsonl"), `${JSON.stringify(ENTRY)}\n{broken\n`);
  assert.equal((await readHistory(dir)).length, 1);
});

test("readHistory returns an empty array when there is no history", async () => {
  assert.deepEqual(await readHistory(newDir()), []);
});

test("aggregate totals reviews, severities, vectors, and duration", () => {
  const stats = aggregate([ENTRY, { ...ENTRY, ts: "2026-07-27T12:00:00Z", duration_ms: 8000 }]);
  assert.equal(stats.reviews, 2);
  assert.equal(stats.findings_total, 6);
  assert.equal(stats.by_severity.CRITICAL, 2);
  assert.equal(stats.by_vector.LOGIC, 4);
  assert.equal(stats.suppressed_total, 2);
  assert.equal(stats.deduped_total, 4);
  assert.equal(stats.avg_duration_ms, 6000);
  assert.equal(stats.first_review, "2026-07-27T10:00:00Z");
  assert.equal(stats.last_review, "2026-07-27T12:00:00Z");
});

test("aggregate handles an empty history", () => {
  const stats = aggregate([]);
  assert.equal(stats.reviews, 0);
  assert.equal(stats.findings_total, 0);
  assert.equal(stats.avg_duration_ms, 0);
});

test("readStats builds stats.json on first run", async () => {
  const dir = newDir();
  await appendHistory(dir, ENTRY);
  const stats = await readStats(dir, {});
  assert.equal(stats.reviews, 1);
  assert.ok(existsSync(join(dir, "stats.json")));
});

test("readStats --rebuild recomputes from history and overwrites a stale cache", async () => {
  const dir = newDir();
  await appendHistory(dir, ENTRY);
  writeFileSync(join(dir, "stats.json"), JSON.stringify({ reviews: 999 }));
  assert.equal((await readStats(dir, {})).reviews, 999);
  assert.equal((await readStats(dir, { rebuild: true })).reviews, 1);
});

test("formatStats renders a human-readable summary", () => {
  const out = formatStats(aggregate([ENTRY]));
  assert.match(out, /Reviews:\s+1/);
  assert.match(out, /CRITICAL/);
  assert.match(out, /CONCURRENCY/);
});

test("formatStats reports an empty history plainly", () => {
  assert.match(formatStats(aggregate([])), /No reviews recorded yet/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd cli && node --test test/stats.test.js`
Expected: FAIL — `Cannot find module '../src/stats.js'`

- [ ] **Step 3: Write `cli/src/stats.js`**

```js
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

/** Ignore everything under .ferret except the shareable suppression cache. */
export const FERRET_GITIGNORE = `# Generated by CodeFerret.
*
!.gitignore
!review-cache.json
`;

async function ensureDir(ferretDir) {
  await mkdir(ferretDir, { recursive: true });
  const gitignore = join(ferretDir, ".gitignore");
  if (!existsSync(gitignore)) await writeFile(gitignore, FERRET_GITIGNORE);
}

export async function appendHistory(ferretDir, entry) {
  await ensureDir(ferretDir);
  await appendFile(join(ferretDir, "history.jsonl"), `${JSON.stringify(entry)}\n`);
}

export async function readHistory(ferretDir) {
  let raw;
  try {
    raw = await readFile(join(ferretDir, "history.jsonl"), "utf8");
  } catch {
    return [];
  }
  const entries = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // skip corrupt line
    }
  }
  return entries;
}

export function aggregate(entries) {
  const stats = {
    reviews: entries.length,
    findings_total: 0,
    by_severity: { CRITICAL: 0, WARNING: 0, SUGGESTION: 0 },
    by_vector: {},
    suppressed_total: 0,
    deduped_total: 0,
    avg_duration_ms: 0,
    first_review: entries[0]?.ts ?? null,
    last_review: entries.at(-1)?.ts ?? null,
  };
  let duration = 0;
  for (const entry of entries) {
    for (const [sev, n] of Object.entries(entry.by_severity ?? {})) {
      stats.by_severity[sev] = (stats.by_severity[sev] ?? 0) + n;
      stats.findings_total += n;
    }
    for (const [vec, n] of Object.entries(entry.by_vector ?? {})) {
      stats.by_vector[vec] = (stats.by_vector[vec] ?? 0) + n;
    }
    stats.suppressed_total += entry.suppressed ?? 0;
    stats.deduped_total += entry.deduped ?? 0;
    duration += entry.duration_ms ?? 0;
  }
  stats.avg_duration_ms = entries.length ? Math.round(duration / entries.length) : 0;
  return stats;
}

export async function readStats(ferretDir, { rebuild = false } = {}) {
  const cache = join(ferretDir, "stats.json");
  if (!rebuild && existsSync(cache)) {
    try {
      return JSON.parse(await readFile(cache, "utf8"));
    } catch {
      // fall through and rebuild
    }
  }
  const stats = aggregate(await readHistory(ferretDir));
  await ensureDir(ferretDir);
  await writeFile(cache, `${JSON.stringify(stats, null, 2)}\n`);
  return stats;
}

export function formatStats(stats) {
  if (stats.reviews === 0) return "No reviews recorded yet. Run `ferret review` first.";
  const lines = [
    `Reviews:          ${stats.reviews}`,
    `Findings:         ${stats.findings_total}`,
    `Suppressed:       ${stats.suppressed_total}`,
    `Deduped:          ${stats.deduped_total}`,
    `Avg duration:     ${(stats.avg_duration_ms / 1000).toFixed(1)}s`,
    `First review:     ${stats.first_review ?? "—"}`,
    `Last review:      ${stats.last_review ?? "—"}`,
    "",
    "By severity:",
  ];
  for (const [sev, n] of Object.entries(stats.by_severity)) lines.push(`  ${sev.padEnd(12)} ${n}`);
  lines.push("", "By vector:");
  for (const [vec, n] of Object.entries(stats.by_vector)) lines.push(`  ${vec.padEnd(12)} ${n}`);
  return lines.join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd cli && node --test test/stats.test.js`
Expected: PASS, 10 tests

- [ ] **Step 5: Commit**

```bash
git add cli/src/stats.js cli/test/stats.test.js
git commit -m "feat(cli): record review history and aggregate stats"
```

---

### Task 9: `ferret doctor`

**Files:**
- Create: `cli/src/doctor.js`
- Test: `cli/test/doctor.test.js`

**Interfaces:**
- Consumes: `repoRoot`, `ferretDir`, `ferretRoot` (Task 1); `detectAgent` (Task 7)
- Produces:
  - `runDoctor({ cwd, env, isInstalled }): Promise<{ checks, exitCode }>`
    - each check: `{ name: string, status: "ok" | "warn" | "fail", detail: string }`
    - `exitCode` is `1` when any check is `fail`, otherwise `0`; `warn` never fails
  - `formatDoctor(result): string`

- [ ] **Step 1: Write the failing test**

Create `cli/test/doctor.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd cli && node --test test/doctor.test.js`
Expected: FAIL — `Cannot find module '../src/doctor.js'`

- [ ] **Step 3: Write `cli/src/doctor.js`**

```js
import { existsSync } from "node:fs";
import { access, constants } from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import { repoRoot, ferretDir, ferretRoot, scriptPath } from "./paths.js";
import { detectAgent, AGENTS } from "./agent.js";

const ANALYZERS = ["eslint", "ruff", "shellcheck", "tsc", "semgrep"];
const MIN_NODE_MAJOR = 20;

function defaultIsInstalled(cmd) {
  return !spawnSync(cmd, ["--version"], {
    stdio: "ignore",
    shell: process.platform === "win32",
  }).error;
}

/**
 * Verify the local setup. Failures exit 1; warnings are reported but do not
 * affect the exit code (matching CodeRabbit's `cr doctor`).
 */
export async function runDoctor({
  cwd = process.cwd(),
  env = process.env,
  isInstalled = defaultIsInstalled,
} = {}) {
  const checks = [];
  const add = (name, status, detail) => checks.push({ name, status, detail });

  const major = Number(process.versions.node.split(".")[0]);
  add(
    "node runtime",
    major >= MIN_NODE_MAJOR ? "ok" : "fail",
    `v${process.versions.node} (requires >=${MIN_NODE_MAJOR})`,
  );

  const root = repoRoot(cwd);
  if (root) {
    let branch = "unknown";
    try {
      branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      branch = "unborn branch";
    }
    add("git repository", "ok", `${root} (${branch})`);
  } else {
    add("git repository", "fail", `${cwd} is not inside a git repository`);
  }

  const dir = ferretDir(cwd);
  if (!dir) {
    add("ferret storage", "warn", "unavailable outside a git repository");
  } else if (existsSync(dir)) {
    try {
      await access(dir, constants.W_OK);
      add("ferret storage", "ok", dir);
    } catch {
      add("ferret storage", "fail", `${dir} is not writable`);
    }
  } else {
    add("ferret storage", "ok", `${dir} (will be created)`);
  }

  add("bash", isInstalled("bash") ? "ok" : "fail", "required by collect-context.sh");
  add("python3", isInstalled("python3") ? "ok" : "fail", "required by run_tools.py and fp_cache.py");

  const agent = detectAgent({ env, isInstalled });
  if (agent) {
    add("host agent", "ok", `${agent.name} (${agent.cmd})`);
  } else {
    add(
      "host agent",
      "fail",
      `none found — install one of: ${AGENTS.map((a) => a.cmd).join(", ")}, ` +
        "or set FERRET_AGENT_CMD",
    );
  }

  const collect = scriptPath("collect-context.sh");
  add(
    "codeferret scripts",
    existsSync(collect) ? "ok" : "fail",
    existsSync(collect) ? ferretRoot() : `not found at ${collect} (set CODEFERRET_ROOT)`,
  );

  const missing = ANALYZERS.filter((a) => !isInstalled(a));
  add(
    "analyzers",
    missing.length === 0 ? "ok" : "warn",
    missing.length === 0 ? ANALYZERS.join(", ") : `not installed: ${missing.join(", ")} (optional)`,
  );

  return { checks, exitCode: checks.some((c) => c.status === "fail") ? 1 : 0 };
}

export function formatDoctor(result) {
  const label = { ok: "OK  ", warn: "WARN", fail: "FAIL" };
  const lines = result.checks.map(
    (c) => `${label[c.status]}  ${c.name.padEnd(20)} ${c.detail}`,
  );
  const failed = result.checks.filter((c) => c.status === "fail").length;
  const warned = result.checks.filter((c) => c.status === "warn").length;
  lines.push("");
  lines.push(
    failed === 0
      ? `All checks passed${warned ? ` (${warned} warning${warned > 1 ? "s" : ""})` : ""}.`
      : `${failed} check${failed > 1 ? "s" : ""} failed.`,
  );
  return lines.join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd cli && node --test test/doctor.test.js`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add cli/src/doctor.js cli/test/doctor.test.js
git commit -m "feat(cli): add ferret doctor diagnostics"
```

---

### Task 10: Command dispatch and review orchestration

**Files:**
- Create: `cli/src/review.js`
- Create: `cli/src/index.js`
- Test: `cli/test/index.test.js`

**Interfaces:**
- Consumes: everything from Tasks 1-9
- Produces:
  - `main(argv, { stdout, stderr, env, cwd }): Promise<number>` — process exit code
  - `parseFlags(argv): { command, sub, values }`
  - `runReview({ flags, stdout, stderr, env, cwd }): Promise<number>`
  - `HELP: string`

- [ ] **Step 1: Write the failing test**

Create `cli/test/index.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { main, parseFlags } from "../src/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE = `${process.execPath} ${join(HERE, "fixtures", "fake-agent.js")}`;

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
  const code = await main(["review", "--uncommitted"], {
    stdout, stderr: capture(), env: baseEnv, cwd,
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
    stdout, stderr: capture(), env: baseEnv, cwd,
  });
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd cli && node --test test/index.test.js`
Expected: FAIL — `Cannot find module '../src/index.js'`

- [ ] **Step 3: Write `cli/src/review.js`**

```js
import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { join } from "node:path";
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

/** Files in scope, used for the empty-diff check and candidate computation. */
async function scopeFiles(cwd, scope) {
  if (scope.target === "uncommitted") {
    const tracked = await gitFiles(cwd, ["diff", "HEAD", "--name-only"]);
    if (!scope.includeUntracked) return tracked;
    return [...tracked, ...(await gitFiles(cwd, ["ls-files", "--others", "--exclude-standard"]))];
  }
  if (scope.target === "all") {
    const changed = await gitFiles(cwd, ["diff", scope.baseRef, "--name-only"]);
    if (!scope.includeUntracked) return changed;
    return [...changed, ...(await gitFiles(cwd, ["ls-files", "--others", "--exclude-standard"]))];
  }
  return gitFiles(cwd, ["diff", `${scope.target}...HEAD`, "--name-only"]);
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

  const files = await scopeFiles(root, scope);
  const agent = detectAgent({ env });
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

  const maxFiles = Number(env.FERRET_MAX_FILES ?? DEFAULT_MAX_FILES);
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
    const message = "No host coding agent found. Install claude, codex, or gemini, or set FERRET_AGENT_CMD. Run `ferret doctor` for details.";
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
  const bySeverity = { CRITICAL: 0, WARNING: 0, SUGGESTION: 0 };
  const byVector = {};
  for (const f of findings) {
    if (bySeverity[f.severity] !== undefined) bySeverity[f.severity] += 1;
    if (f.vector) byVector[f.vector] = (byVector[f.vector] ?? 0) + 1;
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
  await rm(join(dir, "stats.json"), { force: true });

  return 0;
}
```

The cache must be **deleted**, not overwritten with `{}` — `readStats` parses
any valid JSON it finds and returns it as-is, so an empty object would make
`ferret stats` report `undefined` reviews forever.

- [ ] **Step 4: Write `cli/src/index.js`**

```js
import { parseArgs } from "node:util";
import { ScopeError } from "./scope.js";
import { runReview } from "./review.js";
import { runDoctor, formatDoctor } from "./doctor.js";
import { readStats, formatStats } from "./stats.js";
import { readReview, readPrompts, sortFindings } from "./findings.js";
import { formatReport } from "./report.js";
import { ferretDir, repoRoot } from "./paths.js";

export const HELP = `ferret — CodeFerret CLI

Usage:
  ferret [review] [options]      Review the current diff (default command)
  ferret review findings         Replay the last review without re-analyzing
  ferret doctor                  Verify the local setup (exit 1 on failure)
  ferret stats [--rebuild]       Show review statistics from local history

Scope:
  (no flag)                      Committed + staged + unstaged tracked changes
  --committed                    Only committed changes (base...HEAD)
  --uncommitted                  Staged and unstaged edits to tracked files
  --include-untracked            Also include files not added to git
  --base <branch>                Base branch for comparison
  --base-commit <commit>         Base commit for comparison

Options:
  --agent                        Structured JSONL output for coding agents
  --light                        Faster review policy (LOGIC + SECURITY only)
  --show-prompts                 Print saved prompts from the last review
  --dir <path>                   Review directory (must be a git repository)
  -c, --config <file>            Additional instruction file (repeatable)
  --agent-cmd <cmd>              Override host-agent detection
  -h, --help                     Show this help

Environment:
  FERRET_AGENT_CMD               Host agent command override
  FERRET_MAX_FILES               Oversized-diff refusal threshold (default 50)
  CODEFERRET_ROOT                CodeFerret installation root
`;

const OPTIONS = {
  agent: { type: "boolean", default: false },
  light: { type: "boolean", default: false },
  committed: { type: "boolean", default: false },
  uncommitted: { type: "boolean", default: false },
  "include-untracked": { type: "boolean", default: false },
  "show-prompts": { type: "boolean", default: false },
  rebuild: { type: "boolean", default: false },
  base: { type: "string" },
  "base-commit": { type: "string" },
  "agent-cmd": { type: "string" },
  dir: { type: "string" },
  config: { type: "string", short: "c", multiple: true },
  help: { type: "boolean", short: "h", default: false },
};

export function parseFlags(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: OPTIONS,
    allowPositionals: true,
    strict: true,
  });
  const command = positionals[0] ?? "review";
  const sub = positionals[1] ?? null;
  return { command, sub, values };
}

export async function main(argv, io = {}) {
  const {
    stdout = process.stdout,
    stderr = process.stderr,
    env = process.env,
    cwd = process.cwd(),
  } = io;

  let parsed;
  try {
    parsed = parseFlags(argv);
  } catch (err) {
    stderr.write(`error: ${err.message}\n\n${HELP}`);
    return 1;
  }
  const { command, sub, values } = parsed;

  if (values.help) {
    stdout.write(HELP);
    return 0;
  }

  const workdir = values.dir ?? cwd;
  const agentEnv = values["agent-cmd"]
    ? { ...env, FERRET_AGENT_CMD: values["agent-cmd"] }
    : env;

  if (command === "doctor") {
    const result = await runDoctor({ cwd: workdir, env: agentEnv });
    stdout.write(`${formatDoctor(result)}\n`);
    return result.exitCode;
  }

  if (command === "stats") {
    const dir = ferretDir(workdir);
    if (!dir) {
      stderr.write("error: not inside a git repository\n");
      return 1;
    }
    stdout.write(`${formatStats(await readStats(dir, { rebuild: values.rebuild }))}\n`);
    return 0;
  }

  if (command !== "review") {
    stderr.write(`error: unknown command: ${command}\n\n${HELP}`);
    return 1;
  }

  const dir = ferretDir(workdir);
  if (!dir) {
    stderr.write("error: not inside a git repository\n");
    return 1;
  }

  if (sub === "findings") {
    const review = await readReview(dir);
    if (!review) {
      stderr.write("error: No stored review found. Run `ferret review` first.\n");
      return 1;
    }
    const findings = sortFindings(review.findings ?? []);
    stdout.write(`${formatReport({ ...review, findings }, {
      suppressed: review.suppressed ?? 0,
      deduped: review.deduped ?? 0,
    })}\n`);
    return 0;
  }

  if (values["show-prompts"]) {
    const prompts = await readPrompts(dir);
    if (!prompts) {
      stderr.write("error: No saved prompts found. Run `ferret review` first.\n");
      return 1;
    }
    for (const prompt of prompts.prompts ?? []) {
      stdout.write(`=== ${prompt.name} ===\n${prompt.text}\n\n`);
    }
    return 0;
  }

  const flags = {
    agent: values.agent,
    light: values.light,
    committed: values.committed,
    uncommitted: values.uncommitted,
    includeUntracked: values["include-untracked"],
    base: values.base ?? null,
    baseCommit: values["base-commit"] ?? null,
    config: values.config ?? [],
  };

  try {
    return await runReview({ flags, stdout, stderr, env: agentEnv, cwd: workdir });
  } catch (err) {
    if (err instanceof ScopeError) {
      stderr.write(`error: ${err.message}\n`);
      return 1;
    }
    stderr.write(`error: ${err.message}\n`);
    return 1;
  }
}
```

- [ ] **Step 5: Run the full CLI suite to verify it passes**

Run: `cd cli && node --test test/`
Expected: PASS, all suites green

- [ ] **Step 6: Commit**

```bash
git add cli/src/review.js cli/src/index.js cli/test/index.test.js
git commit -m "feat(cli): wire command dispatch and review orchestration"
```

---

### Task 11: Methodology and schema flow-back

**Files:**
- Modify: `skills/code-ferret/references/output-schema.md` (add `codegen_instructions`, `last-prompts.json`, `history.jsonl`)
- Modify: `skills/code-ferret/SKILL.md` (light policy, candidates, prompt persistence)
- Modify: `commands/review.md:43-47` (persist prompts, append history)
- Modify: `.codeferret.example.yaml` (add `reviews.max_files`)

**Interfaces:**
- Consumes: the schema shape from Tasks 4, 5, 8
- Produces: documentation the host agent reads, so `codegen_instructions` is actually populated at review time

- [ ] **Step 1: Add `codegen_instructions` to the schema reference**

In `skills/code-ferret/references/output-schema.md`, add the field to the JSON example after `"patch"` and add this bullet to the field-rules list:

```markdown
- `codegen_instructions`: imperative fix instructions aimed at a coding agent
  ("Wrap the read-modify-write in a transaction"), or `null` when no mechanical
  fix exists. Distinct from `explanation`, which states the failure scenario for
  a human. The CLI's `--agent` output falls back to `explanation` when this is
  absent.
```

- [ ] **Step 2: Document the two new artifacts**

Append to `skills/code-ferret/references/output-schema.md`:

```markdown
## Prompt capture (`.ferret/last-prompts.json`)

Every full review also writes the prompts it used, so `ferret review
--show-prompts` can replay them without re-running analysis:

```json
{
  "generated_at": "2026-07-27T10:30:00Z",
  "target": "all",
  "prompts": [{ "name": "review", "text": "<the full prompt text>" }]
}
```

## Review history (`.ferret/history.jsonl`)

One JSON object per completed review, appended:

```json
{"ts":"2026-07-27T10:30:00Z","target":"all","branch":"main","commit":"abc1234",
 "by_severity":{"CRITICAL":1,"WARNING":2,"SUGGESTION":0},
 "by_vector":{"CONCURRENCY":1,"LOGIC":2},
 "suppressed":1,"deduped":2,"duration_ms":42000,"agent":"claude","light":false}
```

`ferret stats` aggregates this file; `ferret stats --rebuild` recomputes
`.ferret/stats.json` from it. A generated `.ferret/.gitignore` excludes
everything under `.ferret/` except `review-cache.json`, which is meant to be
committed and shared.
```

- [ ] **Step 3: Document the light policy and candidates in the skill**

Append a section to `skills/code-ferret/SKILL.md`:

```markdown
## Light policy

When `FERRET_LIGHT=1` (the CLI's `--light`), trade depth for speed:

- skip the installed-analyzer step entirely
- diff context is already reduced to `-U10` by `collect-context.sh`
- `FERRET_FILE_HISTORY` is absent — do not treat that as "no prior history"
- analyze only the LOGIC and SECURITY vectors

Say in the report that the run was light, so a clean result is not mistaken
for a full-depth pass.

## Oversized scopes

The CLI refuses a scope larger than `reviews.max_files` (default 50) before
invoking any agent, and suggests up to five narrower re-run commands. It never
splits or retries automatically. This is separate from the >15-file guidance
above, which applies to a review you are already performing: group hunks by
directory and cover every one.
```

- [ ] **Step 4: Make the plugin command persist prompts and history**

In `commands/review.md`, replace step 7 with:

```markdown
7. Write the findings JSON to `.ferret/last-review.json` (schema:
   skill references/output-schema.md), including `codegen_instructions` on
   every finding. Also write `.ferret/last-prompts.json` and append one line to
   `.ferret/history.jsonl` per that same reference. Then print the terminal
   report: findings ordered CRITICAL → WARNING → SUGGESTION with clickable
   `file:line:col` locations, and the closing tally including suppressed and
   deduped counts.
```

- [ ] **Step 5: Add the config knob**

Add to `.codeferret.example.yaml` under the `reviews:` block:

```yaml
  # Refuse a review scope larger than this many files and suggest narrower
  # scopes instead. Override per-run with the FERRET_MAX_FILES env var.
  max_files: 50
```

- [ ] **Step 6: Verify the docs are internally consistent**

Run: `bash tests/run.sh && cd cli && node --test test/`
Expected: PASS both suites (docs changes must not break the shell or CLI tests)

- [ ] **Step 7: Commit**

```bash
git add skills/code-ferret commands/review.md .codeferret.example.yaml
git commit -m "docs(skill): document codegen_instructions, prompts, history, light policy"
```

---

### Task 12: MCP server parity and README

**Files:**
- Modify: `mcp-server/server/index.js:70-96` (scope arg enum), and append three tools before the prompt registrations at `:196`
- Modify: `README.md` (add a CLI section after the Commands table)

**Interfaces:**
- Consumes: `runDoctor`/`formatDoctor` (Task 9), `readStats`/`formatStats` (Task 8), `readReview` (Task 5)
- Produces: MCP tools `ferret_doctor`, `ferret_stats`, `ferret_findings`; `targetArg` accepting `all` and `uncommitted`

- [ ] **Step 1: Widen the target argument**

In `mcp-server/server/index.js`, replace the `targetArg` definition (lines 74-78) with:

```js
const targetArg = z
  .enum(["staged", "head", "all", "uncommitted"])
  .or(z.string())
  .optional()
  .describe(
    "Diff target: 'staged' (index only), 'head' (working tree vs HEAD, default), " +
      "'all' (committed + staged + unstaged vs FERRET_BASE_REF), " +
      "'uncommitted' (staged + unstaged tracked, no untracked), or a base ref like 'main'",
  );
```

- [ ] **Step 2: Add the three tools**

First add a loader helper near the top of `mcp-server/server/index.js`, after
the `SKILL_DIR` constant. Dynamic `import()` of an absolute path fails on
Windows unless it is converted to a `file://` URL:

```js
import { pathToFileURL } from "node:url";

/** Import a CLI module by path, Windows-safe. */
function cliModule(name) {
  return import(pathToFileURL(join(ROOT, "cli", "src", name)).href);
}
```

Then insert before the `const REVIEW_PROMPT = ...` line:

```js
server.registerTool(
  "ferret_doctor",
  {
    title: "Verify CodeFerret setup",
    description:
      "Check the local CodeFerret setup: node runtime, git repository state, .ferret storage, bash/python3, host coding agent, script resolution, and optional analyzers. Failures indicate the review cannot run; warnings are informational.",
    inputSchema: { repo_path: repoPathArg },
  },
  async ({ repo_path }) => {
    const { runDoctor, formatDoctor } = await cliModule("doctor.js");
    const result = await runDoctor({ cwd: repo_path || process.cwd() });
    return textResult(formatDoctor(result), result.exitCode !== 0);
  },
);

server.registerTool(
  "ferret_stats",
  {
    title: "CodeFerret review statistics",
    description:
      "Aggregate .ferret/history.jsonl into review counts by severity and vector, suppression and dedup totals, and average duration. Set rebuild to recompute the cached stats from scratch.",
    inputSchema: {
      repo_path: repoPathArg,
      rebuild: z.boolean().optional().describe("Rescan review history and rebuild the stats cache"),
    },
  },
  async ({ repo_path, rebuild }) => {
    const cwd = repo_path || process.cwd();
    const { readStats, formatStats } = await cliModule("stats.js");
    return textResult(formatStats(await readStats(join(cwd, ".ferret"), { rebuild: Boolean(rebuild) })));
  },
);

server.registerTool(
  "ferret_findings",
  {
    title: "Replay stored findings",
    description:
      "Read the findings from the most recent review (.ferret/last-review.json) without re-running analysis. Use in multi-step loops where a later step consumes an earlier review's results.",
    inputSchema: { repo_path: repoPathArg },
  },
  async ({ repo_path }) => {
    const cwd = repo_path || process.cwd();
    try {
      return textResult(await readFile(join(cwd, ".ferret", "last-review.json"), "utf8"));
    } catch {
      return textResult("No stored review found. Run the review prompt first.", true);
    }
  },
);
```

- [ ] **Step 3: Verify the MCP server still parses**

Run: `cd mcp-server && npm install && node --check server/index.js`
Expected: no output, exit 0. (Do not run the server itself — it blocks on a stdio transport.)

- [ ] **Step 4: Add the README section**

Insert after the Commands table in `README.md`:

````markdown
## CLI

CodeFerret also ships a standalone CLI that runs reviews from any terminal by
delegating to a coding agent you already have installed (`claude`, `codex`, or
`gemini`) — no API key and no CodeFerret account.

```bash
cd cli && npm link      # or: npm install -g ./cli
ferret doctor           # verify the setup first
ferret                  # review committed + staged + unstaged changes
```

| Command | What it does |
|---|---|
| `ferret [review]` | Review the current diff; plain-text report |
| `ferret review --agent` | Structured JSONL for coding agents and automation |
| `ferret review --light` | Fast policy: no analyzers, `-U10` context, LOGIC + SECURITY only |
| `ferret review findings` | Replay the last review without re-analyzing |
| `ferret review --show-prompts` | Print the prompts from the last review |
| `ferret doctor` | Verify setup and connectivity; exit 1 on failure |
| `ferret stats [--rebuild]` | Review statistics from `.ferret/history.jsonl` |

Scope flags: `--committed`, `--uncommitted`, `--include-untracked`,
`--base <branch>`, `--base-commit <sha>`, `--dir <path>`, `-c/--config <file>`.
Contradictory combinations are rejected before a review starts.

Every `ferret review` spawns a real agent session against your existing
subscription. Use `--light` for the cheap path, and keep the git pre-commit
hook on the pure-bash secret scan rather than a full review.
````

- [ ] **Step 5: Run the complete test suite**

Run: `bash tests/run.sh && cd cli && node --test test/ && cd ../worker && npm test`
Expected: PASS all three suites

- [ ] **Step 6: Commit**

```bash
git add mcp-server/server/index.js README.md
git commit -m "feat(mcp): add doctor/stats/findings tools; document the CLI"
```

---

## Verification

After Task 12, confirm end to end in a scratch repository:

```bash
cd "$(mktemp -d)" && git init -q -b main && echo hi > a.txt && git add . && git commit -qm init
echo change >> a.txt
ferret doctor
ferret review --uncommitted
ferret review --uncommitted --agent | head -5
ferret stats
```

Expected: `doctor` exits 0 with a detected agent, the review prints a report,
`--agent` emits JSONL beginning with a `review_context` event, and `stats`
reports one review.
