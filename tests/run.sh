#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_TMP="$(mktemp -d)"
trap 'rm -rf "$TEST_TMP"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_contains() {
  [[ "$1" == *"$2"* ]] || fail "expected output to contain: $2"
}

REPO="$TEST_TMP/repo"
mkdir -p "$REPO"
git -C "$REPO" init -q
git -C "$REPO" config user.email tests@codeferret.local
git -C "$REPO" config user.name "CodeFerret Tests"
printf 'baseline\n' > "$REPO/app.txt"
git -C "$REPO" add app.txt
git -C "$REPO" commit -qm baseline

printf 'new file\n' > "$REPO/fresh.ts"
printf 'version: 1\nreviews:\n  profile: assertive\n' > "$REPO/.codeferret.yaml"
printf '# Repository policy\nCheck database migrations for rollback safety.\n' > "$REPO/AGENTS.md"
CONTEXT="$(cd "$REPO" && bash "$ROOT/scripts/collect-context.sh" head)"
assert_contains "$CONTEXT" $'A\tfresh.ts'
assert_contains "$CONTEXT" "+++ b/fresh.ts"
assert_contains "$CONTEXT" "=== FERRET_CONFIG ==="
assert_contains "$CONTEXT" "profile: assertive"
assert_contains "$CONTEXT" "=== FERRET_REPOSITORY_GUIDELINES ==="
assert_contains "$CONTEXT" "Check database migrations for rollback safety."

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

# --- FERRET_DIR_PATHSPEC (--dir) must actually restrict what's collected ----
# Whole-branch review finding: the CLI's own file-count accounting already
# respected --dir, but nothing told collect-context.sh to narrow the diff it
# hands to the host agent, so --dir's promise not to expose other subtrees to
# a third-party LLM silently didn't hold. app.txt still has the uncommitted
# "tracked edit" from above, and fresh.ts is still untracked -- both outside
# "sub/".
mkdir -p "$REPO/sub"
printf 'baseline\n' > "$REPO/sub/scoped.txt"
git -C "$REPO" add sub/scoped.txt
git -C "$REPO" commit -qm "add sub/scoped.txt"
printf 'scoped edit\n' >> "$REPO/sub/scoped.txt"
printf 'new scoped file\n' > "$REPO/sub/fresh-scoped.ts"

DIR_SCOPED="$(cd "$REPO" && FERRET_DIR_PATHSPEC=sub bash "$ROOT/scripts/collect-context.sh" uncommitted)"
assert_contains "$DIR_SCOPED" "+++ b/sub/scoped.txt"
[[ "$DIR_SCOPED" != *"+++ b/app.txt"* ]] || fail "FERRET_DIR_PATHSPEC must exclude tracked diffs outside the subtree"

DIR_SCOPED_UT="$(cd "$REPO" && FERRET_DIR_PATHSPEC=sub FERRET_INCLUDE_UNTRACKED=1 bash "$ROOT/scripts/collect-context.sh" uncommitted)"
assert_contains "$DIR_SCOPED_UT" "+++ b/sub/fresh-scoped.ts"
[[ "$DIR_SCOPED_UT" != *"+++ b/fresh.ts"* ]] || fail "FERRET_DIR_PATHSPEC must exclude untracked files outside the subtree"

UNSCOPED="$(cd "$REPO" && bash "$ROOT/scripts/collect-context.sh" uncommitted)"
assert_contains "$UNSCOPED" "+++ b/app.txt"
assert_contains "$UNSCOPED" "+++ b/sub/scoped.txt"

set +e
INVALID_CONTEXT="$(cd "$REPO" && bash "$ROOT/scripts/collect-context.sh" missing-ref 2>&1)"
INVALID_CONTEXT_STATUS=$?
INVALID_SCAN="$(cd "$REPO" && bash "$ROOT/scripts/scan-secrets.sh" missing-ref 2>&1)"
INVALID_SCAN_STATUS=$?
set -e
[[ "$INVALID_CONTEXT_STATUS" -eq 2 ]] || fail "invalid context ref should exit 2"
[[ "$INVALID_SCAN_STATUS" -eq 2 ]] || fail "invalid scan ref should exit 2"
assert_contains "$INVALID_CONTEXT" "unknown base ref"
assert_contains "$INVALID_SCAN" "unknown base ref"

printf 'api_key = "abcdefghijklmnopqrstuvwxyz123456"\n' > "$REPO/app.txt"
git -C "$REPO" add app.txt
set +e
GUARD_OUTPUT="$(cd "$REPO" && printf '%s' '{"tool_input":{"command":"git -c user.name=test commit -m x"}}' | bash "$ROOT/scripts/precommit-guard.sh" 2>&1)"
GUARD_STATUS=$?
set -e
[[ "$GUARD_STATUS" -eq 2 ]] || fail "git -c ... commit should be blocked"
assert_contains "$GUARD_OUTPUT" "potential credentials"

set +e
UNCONFIGURED_OUTPUT="$(cd "$REPO" && env -u CODE_FERRET_ROOT bash "$ROOT/examples/git-pre-commit-hook" 2>&1)"
UNCONFIGURED_STATUS=$?
set -e
[[ "$UNCONFIGURED_STATUS" -eq 1 ]] || fail "unconfigured native hook should fail closed"
assert_contains "$UNCONFIGURED_OUTPUT" "not configured"

git -C "$REPO" config codeferret.root "$ROOT"
set +e
CONFIGURED_OUTPUT="$(cd "$REPO" && env -u CODE_FERRET_ROOT bash "$ROOT/examples/git-pre-commit-hook" 2>&1)"
CONFIGURED_STATUS=$?
set -e
[[ "$CONFIGURED_STATUS" -eq 1 ]] || fail "configured native hook should block staged secret"
assert_contains "$CONFIGURED_OUTPUT" "commit blocked"

python3 "$ROOT/tests/test_run_tools.py"
python3 "$ROOT/tests/test_check_models.py"

printf 'CodeFerret shell integration tests passed.\n'
