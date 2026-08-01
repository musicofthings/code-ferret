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

# --- token-cost controls: FERRET_OUT / FERRET_FILES / lockfiles / sharding ---
# Collection is the dominant token cost of a review, so each of these has a
# cost claim attached; a regression here is silent and expensive.

# FERRET_OUT: payload to disk, only an index on stdout.
OUT_FILE="$REPO/.ferret/ctx.txt"
OUT_INDEX="$(cd "$REPO" && FERRET_OUT=".ferret/ctx.txt" bash "$ROOT/scripts/collect-context.sh" uncommitted)"
assert_contains "$OUT_INDEX" "=== FERRET_INDEX ==="
assert_contains "$OUT_INDEX" "context_file: .ferret/ctx.txt"
[[ -f "$OUT_FILE" ]] || fail "FERRET_OUT must write the payload to disk"
assert_contains "$(cat "$OUT_FILE")" "=== FERRET_DIFF ==="
[[ "$OUT_INDEX" != *"+++ b/app.txt"* ]] || fail "FERRET_OUT must keep diff hunks off stdout"
[[ "${#OUT_INDEX}" -lt "$(wc -c < "$OUT_FILE")" ]] || fail "FERRET_OUT index must be smaller than the payload"

# FERRET_FILES: shard to a subset. The trailing-newline bug this guards against
# silently dropped the LAST file in the list, so assert both ends explicitly.
SHARD="$(cd "$REPO" && FERRET_FILES="app.txt:sub/scoped.txt" bash "$ROOT/scripts/collect-context.sh" uncommitted)"
assert_contains "$SHARD" "+++ b/app.txt"
assert_contains "$SHARD" "+++ b/sub/scoped.txt"
SHARD_ONE="$(cd "$REPO" && FERRET_FILES="sub/scoped.txt" bash "$ROOT/scripts/collect-context.sh" uncommitted)"
[[ "$SHARD_ONE" != *"+++ b/app.txt"* ]] || fail "FERRET_FILES must exclude files outside the shard"

# FERRET_SKIP_GUIDELINES: name retained, body dropped.
printf 'repo policy body marker ZZQQ\n' > "$REPO/CLAUDE.md"
git -C "$REPO" add CLAUDE.md
git -C "$REPO" commit -qm "add CLAUDE.md"
GUIDE_ON="$(cd "$REPO" && bash "$ROOT/scripts/collect-context.sh" uncommitted)"
GUIDE_OFF="$(cd "$REPO" && FERRET_SKIP_GUIDELINES=1 bash "$ROOT/scripts/collect-context.sh" uncommitted)"
assert_contains "$GUIDE_ON" "repo policy body marker ZZQQ"
assert_contains "$GUIDE_OFF" "CLAUDE.md (already in host context; body omitted)"
[[ "$GUIDE_OFF" != *"repo policy body marker ZZQQ"* ]] || fail "FERRET_SKIP_GUIDELINES must drop guideline bodies"

# Lockfiles: hunks suppressed by default, name still visible, opt-in restores.
printf '{"lockfileVersion":3,"packages":{"zzlockmarker":1}}\n' > "$REPO/package-lock.json"
git -C "$REPO" add package-lock.json
git -C "$REPO" commit -qm "add lockfile"
printf '{"lockfileVersion":3,"packages":{"zzlockmarker":2}}\n' > "$REPO/package-lock.json"
LOCK_DEFAULT="$(cd "$REPO" && bash "$ROOT/scripts/collect-context.sh" uncommitted)"
assert_contains "$LOCK_DEFAULT" "package-lock.json"
assert_contains "$LOCK_DEFAULT" "lockfile hunks omitted"
[[ "$LOCK_DEFAULT" != *"zzlockmarker"* ]] || fail "lockfile hunks must be suppressed by default"
LOCK_ON="$(cd "$REPO" && FERRET_INCLUDE_LOCKFILES=1 bash "$ROOT/scripts/collect-context.sh" uncommitted)"
assert_contains "$LOCK_ON" "zzlockmarker"

# plan-shards.sh: every reviewable file placed exactly once, no lockfiles.
PLAN="$(cd "$REPO" && bash "$ROOT/scripts/plan-shards.sh" uncommitted 3)"
[[ -n "$PLAN" ]] || fail "plan-shards.sh must emit at least one shard"
PLAN_FILES="$(printf '%s\n' "$PLAN" | tr ':' '\n' | grep -c . || true)"
PLAN_UNIQ="$(printf '%s\n' "$PLAN" | tr ':' '\n' | grep . | sort -u | wc -l | tr -d ' ')"
[[ "$PLAN_FILES" -eq "$PLAN_UNIQ" ]] || fail "plan-shards.sh must not place a file in two shards"
[[ "$PLAN" != *"package-lock.json"* ]] || fail "plan-shards.sh must not weight suppressed lockfiles"
assert_contains "$PLAN" "app.txt"
[[ "$(printf '%s\n' "$PLAN" | wc -l | tr -d ' ')" -le 3 ]] || fail "plan-shards.sh must respect the shard count"

# Function context: an edit deep inside a long function must still show the
# whole function. A fixed -U count cannot do this (measured 5.5% coverage at
# -U12 on a 617-line function), so -W is the default outside light mode.
mkdir -p "$REPO/src"
{
  printf 'def big():\n'
  for i in $(seq 1 60); do printf '    a%s = %s\n' "$i" "$i"; done
  printf '    return MARKER_TOP\n'
} > "$REPO/src/big.py"
git -C "$REPO" add src/big.py
git -C "$REPO" commit -qm "add big.py"
# Change one line at the very bottom of the function.
sed -i.bak 's/return MARKER_TOP/return MARKER_CHANGED/' "$REPO/src/big.py"
rm -f "$REPO/src/big.py.bak"

# "a1 = 1" sits at the TOP of the function body, ~60 lines above the edit, so
# only -W reaches it. Do not assert on "def big():": git prints the enclosing
# function name in the @@ hunk header at every -U setting, so it proves nothing.
FN_ON="$(cd "$REPO" && FERRET_FILES="src/big.py" bash "$ROOT/scripts/collect-context.sh" uncommitted)"
assert_contains "$FN_ON" "MARKER_CHANGED"
assert_contains "$FN_ON" "a1 = 1"

FN_OFF="$(cd "$REPO" && FERRET_FILES="src/big.py" FERRET_FUNCTION_CONTEXT=0 \
  bash "$ROOT/scripts/collect-context.sh" uncommitted)"
assert_contains "$FN_OFF" "MARKER_CHANGED"
[[ "$FN_OFF" != *"a1 = 1"* ]] || fail "FERRET_FUNCTION_CONTEXT=0 should fall back to a fixed -U window"
[[ "${#FN_OFF}" -lt "${#FN_ON}" ]] || fail "fixed -U window should be smaller than function context"

# Light mode trades depth for speed on purpose: it must NOT pull whole functions.
FN_LIGHT="$(cd "$REPO" && FERRET_FILES="src/big.py" FERRET_LIGHT=1 \
  bash "$ROOT/scripts/collect-context.sh" uncommitted)"
[[ "$FN_LIGHT" != *"a1 = 1"* ]] || fail "light mode must not use function context"

set +e
PLAN_BAD="$(cd "$REPO" && bash "$ROOT/scripts/plan-shards.sh" uncommitted 0 2>&1)"
PLAN_BAD_STATUS=$?
set -e
[[ "$PLAN_BAD_STATUS" -eq 2 ]] || fail "plan-shards.sh must reject a non-positive shard count"

# --- secret scanner coverage -------------------------------------------------
# The generic keyword pattern used to anchor the keyword immediately before the
# "=", so it caught DB_PASSWORD (PASSWORD ends the name) but missed
# AWS_SECRET_ACCESS_KEY and STRIPE_SECRET_KEY -- the canonical names for two of
# the most widely used credentials. Every shape below must stay caught.
scan_staged() { # file-content -> echoes CAUGHT or MISSED
  printf '%s\n' "$1" > "$REPO/cred_probe.txt"
  git -C "$REPO" add cred_probe.txt
  # scan-secrets.sh exits 1 when it FINDS something, so capture its output
  # before testing it: piping it straight into grep makes pipefail report the
  # detection as a pipeline failure and inverts the result.
  local out
  set +e
  out="$(cd "$REPO" && bash "$ROOT/scripts/scan-secrets.sh" staged 2>&1)"
  set -e
  case "$out" in
    *SECRETS_DETECTED*) echo CAUGHT ;;
    *)                  echo MISSED ;;
  esac
}
must_catch() {
  [[ "$(scan_staged "$1")" == CAUGHT ]] || fail "secret scanner must catch: $2"
}
must_ignore() {
  [[ "$(scan_staged "$1")" == MISSED ]] || fail "secret scanner must not flag: $2"
}

# Provider-format fixtures are assembled from fragments at run time. Written as
# whole literals they are indistinguishable from live credentials to upstream
# scanners -- GitHub push protection rejected this very file over the Stripe
# one -- while the scanner under test still sees the fully-formed line.
FILLER="abcdefghijklmnopqrstuvwx"
AWS_SEC="wJalrXUtnFEMI/K7MDENG/bPxRfi""CYEXAMPLE""KEY"
AWS_ID="AKIA""IOSFODNN7""EXAMPLE"
STRIPE="sk_""live_""$FILLER"
GITHUB="ghp_""$FILLER""0123456789ab"
ANTHROPIC="sk-""ant-""api03-""$FILLER"
GOOGLE="AIza""SyA1234567890""$FILLER""zab"
LONGPW="sup3rs3cretp4ssw0rd12345"

must_catch "AWS_SECRET_ACCESS_KEY = \"$AWS_SEC\"" "AWS_SECRET_ACCESS_KEY"
must_catch "STRIPE_SECRET_KEY = \"$STRIPE\""      "STRIPE_SECRET_KEY"
must_catch "DB_PASSWORD = \"$LONGPW\""            "DB_PASSWORD"
must_catch "password = \"$LONGPW\""               "bare password"
must_catch "secret = \"$FILLER$FILLER\""          "bare secret"
must_catch 'api_key = "abcdef1234567890abcdef1234567890"' "api_key"
must_catch "aws_id = \"$AWS_ID\""                 "AWS access key id"
must_catch "tok = \"$GITHUB\""                    "GitHub token"
must_catch "k = \"$ANTHROPIC\""                   "Anthropic key"
must_catch "g = \"$GOOGLE\""                      "Google API key"
must_catch '-----BEGIN RSA PRIVATE KEY-----'      "RSA private key"

must_ignore 'api_key = os.environ["MY_API_KEY_NAME_HERE_LONG"]'                 "env var reference"
must_ignore 'secret = "abc"'                                                    "short value"
must_ignore '# set SECRET_ACCESS_KEY in your environment before running'        "prose comment"

git -C "$REPO" rm -q --cached cred_probe.txt
rm -f "$REPO/cred_probe.txt"

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

printf 'CodeFerret shell integration tests passed.\n'
