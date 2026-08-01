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

# Placeholders in .env.example files and docs are not secrets. Blocking a commit
# over one teaches people to bypass the hook, which costs more than it saves.
# The filter applies ONLY to the broad keyword rule, and only when the value is
# both worded like a placeholder and lacking a real credential's character mix
# -- which is why $AWS_SEC above stays caught despite containing "EXAMPLE".
must_ignore 'password = "your-password-here-replace-me"'                        "placeholder: your-...-here"
must_ignore 'DB_PASSWORD = "changeme-changeme-changeme"'                        "placeholder: changeme"
must_ignore 'api_key = "your-example-api-key-here"'                             "placeholder: example value"
must_ignore 'token = "replace-with-your-real-token"'                            "placeholder: replace-with"
# A structurally unambiguous credential is never placeholder-filtered, even
# when it is literally a documented sample.
must_catch "aws_id = \"$AWS_ID\""                                               "AWS key id is never placeholder-filtered"
must_catch 'secret = "REPLACE/ME+WITH1234567890abcdEFGH"'                       "mixed-case value with symbols is not a placeholder"

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

# --- false-positive cache ----------------------------------------------------
# The suppression round trip is what makes repeat reviews usable: dismiss a
# finding once and its structural pattern stays quiet as the code moves around
# it. That means the hash must be stable across the things that legitimately
# drift (line numbers, whitespace, case, directory) and must NOT collide across
# the things that distinguish findings (file, vector, wording).
FPC="python3 $ROOT/scripts/fp_cache.py"
fp_hash() { (cd "$REPO" && $FPC hash "$1" "$2" "$3"); }
fp_check() { # -> SUPPRESSED | OPEN
  local st
  set +e
  (cd "$REPO" && $FPC check "$1" "$2" "$3" >/dev/null 2>&1)
  st=$?
  set -e
  [[ "$st" -eq 0 ]] && echo SUPPRESSED || echo OPEN
}

MSG='Race condition during balance debit at line 42'
[[ "$(fp_check src/pay.py CONCURRENCY "$MSG")" == OPEN ]] \
  || fail "an unrecorded finding must not be suppressed"

# Nothing is written until a human actually dismisses something.
[[ ! -f "$REPO/.ferret/review-cache.json" ]] || fail "check must not create the cache"

(cd "$REPO" && $FPC add src/pay.py CONCURRENCY "$MSG" "guarded by an outer transaction" >/dev/null)
[[ -f "$REPO/.ferret/review-cache.json" ]] || fail "add must persist the cache"
[[ "$(fp_check src/pay.py CONCURRENCY "$MSG")" == SUPPRESSED ]] \
  || fail "a recorded finding must be suppressed"

# Stable across drift: line numbers, whitespace, case, and directory moves.
[[ "$(fp_check src/pay.py CONCURRENCY 'Race condition during balance debit at line 987')" == SUPPRESSED ]] \
  || fail "suppression must survive a line-number change"
[[ "$(fp_check src/pay.py CONCURRENCY 'Race   condition during   balance debit at line 42')" == SUPPRESSED ]] \
  || fail "suppression must survive whitespace changes"
[[ "$(fp_check src/pay.py concurrency 'RACE CONDITION DURING BALANCE DEBIT AT LINE 42')" == SUPPRESSED ]] \
  || fail "suppression must be case-insensitive"
[[ "$(fp_check billing/v2/pay.py CONCURRENCY "$MSG")" == SUPPRESSED ]] \
  || fail "suppression keys on basename, so a moved file stays suppressed"

# Distinct across the things that make a finding a different finding.
[[ "$(fp_check src/other.py CONCURRENCY "$MSG")" == OPEN ]] \
  || fail "a different file must not inherit a suppression"
[[ "$(fp_check src/pay.py LOGIC "$MSG")" == OPEN ]] \
  || fail "a different vector must not inherit a suppression"
[[ "$(fp_check src/pay.py CONCURRENCY 'Unbounded retry loop never terminates')" == OPEN ]] \
  || fail "a different message must not inherit a suppression"

# hash is deterministic and agrees with what add/check use.
H1="$(fp_hash src/pay.py CONCURRENCY "$MSG")"
H2="$(fp_hash src/pay.py CONCURRENCY "$MSG")"
[[ -n "$H1" && "$H1" == "$H2" ]] || fail "suppression hash must be deterministic"
[[ "$(fp_hash src/pay.py CONCURRENCY 'a wholly different finding')" != "$H1" ]] \
  || fail "different messages must hash differently"

FP_LIST="$(cd "$REPO" && $FPC list 2>&1)"
assert_contains "$FP_LIST" "$H1"
assert_contains "$FP_LIST" "guarded by an outer transaction"

# The cache is meant to be committed and shared, so it must stay valid JSON
# with the reason preserved for whoever reads it later.
python3 - "$REPO/.ferret/review-cache.json" <<'PY' || fail "review-cache.json must be valid, shareable JSON"
import json, sys
d = json.load(open(sys.argv[1]))
assert d.get("version") == 1, d
s = d.get("suppressions") or {}
assert len(s) == 1, s
entry = next(iter(s.values()))
blob = json.dumps(entry)
assert "outer transaction" in blob, entry
PY

# A corrupt cache must not take the review down with it.
printf 'not json at all\n' > "$REPO/.ferret/review-cache.json"
[[ "$(fp_check src/pay.py CONCURRENCY "$MSG")" == OPEN ]] \
  || fail "a corrupt cache must degrade to 'not suppressed', not crash"
rm -f "$REPO/.ferret/review-cache.json"

# --- triage mechanics --------------------------------------------------------
# /code-ferret:triage is prompt-driven, so what can be pinned here is the
# machinery it drives: read the findings file, apply a patch with git apply,
# record a suppression, and notice a finding whose location has drifted. This
# is the only command that writes to the working tree, so a break here is
# destructive rather than merely noisy.
TRI="$TEST_TMP/triage"
mkdir -p "$TRI"
git -C "$TRI" init -q .
git -C "$TRI" config user.email t@example.com
git -C "$TRI" config user.name T
printf 'def total(xs):\n    return sum(xs) / len(xs)\n' > "$TRI/calc.py"
git -C "$TRI" add -A
git -C "$TRI" commit -qm base

cat > "$TRI/patch.diff" <<'EOF'
--- a/calc.py
+++ b/calc.py
@@ -1,2 +1,4 @@
 def total(xs):
+    if not xs:
+        return 0
     return sum(xs) / len(xs)
EOF
python3 - "$TRI" <<'PY'
import json, pathlib, sys
root = pathlib.Path(sys.argv[1])
(root / ".ferret").mkdir(exist_ok=True)
(root / ".ferret" / "last-review.json").write_text(json.dumps({
    "generated_at": "2026-08-01T00:00:00Z", "target": "head",
    "findings": [{
        "id": "f1", "file": "calc.py", "line": 2, "character": 12,
        "severity": "CRITICAL", "vector": "LOGIC", "confidence": "HIGH",
        "message": "ZeroDivisionError on an empty sequence",
        "explanation": "len(xs) is 0 for an empty list, so total([]) raises.",
        "patch": (root / "patch.diff").read_text(),
        "codegen_instructions": "Guard the empty case before dividing.",
        "suppression_hash": "deadbeefdeadbeef",
    }],
}, indent=2))
PY

# The findings file triage consumes must round-trip and carry a usable patch.
# Extract via python, not command substitution: $(...) strips trailing newlines
# and git apply rejects a patch whose final line has none.
python3 -c "
import json,pathlib,sys
root=pathlib.Path(sys.argv[1])
d=json.loads((root/'.ferret'/'last-review.json').read_text())
p=d['findings'][0]['patch']
(root/'extracted.diff').write_text(p if p.endswith('\n') else p+'\n')" "$TRI"
(cd "$TRI" && git apply --check extracted.diff) \
  || fail "a patch stored in last-review.json must apply cleanly when extracted"

# Accept & apply patch.
(cd "$TRI" && git apply extracted.diff) || fail "triage must be able to apply a stored patch"
assert_contains "$(cat "$TRI/calc.py")" "if not xs:"
python3 -c "import ast,sys; ast.parse(open(sys.argv[1]).read())" "$TRI/calc.py" \
  || fail "an applied patch must leave the file parseable"

# Applying twice must fail rather than silently corrupt the file.
set +e
(cd "$TRI" && git apply extracted.diff 2>/dev/null)
TRI_TWICE=$?
set -e
[[ "$TRI_TWICE" -ne 0 ]] || fail "re-applying an applied patch must fail, not double-patch"

# Ignore pattern: the suppression triage records must silence the same finding.
(cd "$TRI" && $FPC add calc.py LOGIC "ZeroDivisionError on an empty sequence" "guarded upstream" >/dev/null)
set +e
(cd "$TRI" && $FPC check calc.py LOGIC "ZeroDivisionError on an empty sequence" >/dev/null 2>&1)
TRI_SUP=$?
set -e
[[ "$TRI_SUP" -eq 0 ]] || fail "triage's Ignore pattern must suppress the finding on a re-run"

# Stale findings: triage skips a finding whose location no longer matches.
printf 'def total(xs):\n    return 0\n' > "$TRI/calc.py"
(cd "$TRI" && git apply --check extracted.diff 2>/dev/null) \
  && fail "a drifted patch must not report as applicable" || true

# Contract: triage must use the cache and git apply, and must not silently
# rewrite the tree without the user choosing to.
TRIAGE_MD="$ROOT/commands/triage.md"
grep -q 'fp_cache.py' "$TRIAGE_MD"        || fail "triage must record suppressions via fp_cache.py"
grep -q 'git apply' "$TRIAGE_MD"          || fail "triage must apply patches with git apply"
grep -qi 'AskUserQuestion' "$TRIAGE_MD"   || fail "triage must ask before acting on each finding"
grep -qi 'stale' "$TRIAGE_MD"             || fail "triage must handle findings whose location drifted"
grep -q 'last-review.json' "$TRIAGE_MD"   || fail "triage must read the findings file"
# /review is read-only; only triage writes.
grep -qi 'do NOT modify the working tree' "$ROOT/commands/review.md" \
  || fail "/review must state that it does not modify the working tree"

# --- sequential batching (fan-out must never happen) -------------------------
# Reviews run in ONE context. Subagents were removed in 0.4.0: each one starts
# cold, re-derives context the orchestrator already holds, and re-reads shared
# files, so a parallel review costs a multiple of a sequential one for the same
# findings. plan-shards.sh survives to split a large diff into balanced batches
# processed in sequence, not to feed parallel agents.
FAN="$TEST_TMP/batching"
mkdir -p "$FAN"
git -C "$FAN" init -q .
git -C "$FAN" config user.email fan@example.com
git -C "$FAN" config user.name Fan

# 20 files whose DIFFS are deliberately uneven -- file i gains i*20 lines, a
# 20x spread. Varying file size instead would prove nothing: plan-shards.sh
# weights by diff size, so twenty large files each gaining one line all weigh
# the same and any splitter looks balanced.
mkdir -p "$FAN/src"
python3 - "$FAN" <<'EOF'
import pathlib, sys
root = pathlib.Path(sys.argv[1])
for i in range(1, 21):
    (root / "src" / f"mod{i}.py").write_text(f"def mod{i}(x):\n    return x\n")
(root / "package-lock.json").write_text('{"lockfileVersion":3,"packages":{}}\n')
EOF
git -C "$FAN" add -A
git -C "$FAN" commit -qm "batching baseline"
FAN_BASE="$(git -C "$FAN" rev-parse HEAD)"

python3 - "$FAN" <<'EOF'
import pathlib, sys
root = pathlib.Path(sys.argv[1])
for i in range(1, 21):
    p = root / "src" / f"mod{i}.py"
    p.write_text(p.read_text() + "".join(f"    v{j} = {j}\n" for j in range(1, i * 20 + 1)))
EOF
git -C "$FAN" add -A
git -C "$FAN" commit -qm "batching change"

FAN_PLAN="$(cd "$FAN" && bash "$ROOT/scripts/plan-shards.sh" "$FAN_BASE" 5)"
[[ "$(printf '%s\n' "$FAN_PLAN" | grep -c .)" -eq 5 ]] || fail "expected 5 batches"

# Partition: every reviewable file in exactly one batch, lockfile in none.
FAN_PLANNED="$(printf '%s\n' "$FAN_PLAN" | tr ':' '\n' | grep . | sort)"
FAN_TRUTH="$(git -C "$FAN" diff "$FAN_BASE...HEAD" --name-only | grep -v package-lock.json | sort)"
[[ "$FAN_PLANNED" == "$FAN_TRUTH" ]] || fail "batch plan must cover every reviewable file exactly once"
[[ "$(printf '%s\n' "$FAN_PLANNED" | sort -u | wc -l)" -eq "$(printf '%s\n' "$FAN_PLANNED" | wc -l)" ]] \
  || fail "a file appears in more than one batch"
[[ "$FAN_PLAN" != *package-lock.json* ]] || fail "lockfile must not consume a batch"

# Batches must sum to about one collection. Sequential batching cannot cost a
# multiple of the diff; if it does, FERRET_FILES stopped scoping.
FAN_WHOLE="$(cd "$FAN" && bash "$ROOT/scripts/collect-context.sh" "$FAN_BASE" 2>/dev/null | wc -c)"
FAN_SUM=0; FAN_MAX=0
while IFS= read -r shard; do
  [[ -z "$shard" ]] && continue
  n="$(cd "$FAN" && FERRET_FILES="$shard" bash "$ROOT/scripts/collect-context.sh" "$FAN_BASE" 2>/dev/null | wc -c)"
  FAN_SUM=$(( FAN_SUM + n )); [[ "$n" -gt "$FAN_MAX" ]] && FAN_MAX="$n"
done <<< "$FAN_PLAN"
[[ "$FAN_SUM" -lt $(( FAN_WHOLE * 2 )) ]] \
  || fail "batched collection ($FAN_SUM) must stay near one collection ($FAN_WHOLE)"
# Balanced packing keeps each sequential batch a similar size. Threshold is
# empirical: the shipped longest-processing-time-first packer puts 20% of the
# bytes in its largest batch (20% is the floor for 5), a size-blind round-robin
# by filename puts 25%.
[[ $(( FAN_MAX * 100 )) -lt $(( FAN_SUM * 23 )) ]] \
  || fail "largest batch is $(( FAN_MAX * 100 / FAN_SUM ))% of the total; expected <23%"

# A balanced plan must say nothing. Warning on every run trains people to
# ignore the one case that matters.
[[ -z "$(cd "$FAN" && bash "$ROOT/scripts/plan-shards.sh" "$FAN_BASE" 5 2>&1 >/dev/null)" ]] \
  || fail "a balanced plan must not emit a warning"

# A batch cannot be split below one file, so a single dominant file caps how
# even the plan can get. That must be surfaced, not silently shipped as a
# "balanced" plan.
DOM="$TEST_TMP/dominant"
mkdir -p "$DOM"; git -C "$DOM" init -q .
git -C "$DOM" config user.email d@example.com; git -C "$DOM" config user.name D
for i in 1 2 3 4 5; do printf 'x\n' > "$DOM/f$i.py"; done
git -C "$DOM" add -A; git -C "$DOM" commit -qm base
DOM_BASE="$(git -C "$DOM" rev-parse HEAD)"
python3 - "$DOM" <<'EOF'
import pathlib, sys
root = pathlib.Path(sys.argv[1])
(root / "f1.py").write_text("x\n" + "".join(f"a{i}=1\n" for i in range(2000)))
for i in range(2, 6):
    (root / f"f{i}.py").write_text("x\n" + "".join(f"b{j}=1\n" for j in range(5)))
EOF
git -C "$DOM" add -A; git -C "$DOM" commit -qm change
DOM_ERR="$(cd "$DOM" && bash "$ROOT/scripts/plan-shards.sh" "$DOM_BASE" 5 2>&1 >/dev/null)"
assert_contains "$DOM_ERR" "f1.py"
assert_contains "$DOM_ERR" "cannot be split further"
# The note goes to stderr so it never corrupts the batch list on stdout.
DOM_OUT="$(cd "$DOM" && bash "$ROOT/scripts/plan-shards.sh" "$DOM_BASE" 5 2>/dev/null)"
[[ "$DOM_OUT" != *"note:"* ]] || fail "the dominance note must not contaminate stdout"
[[ "$(printf '%s\n' "$DOM_OUT" | tr ':' '\n' | grep -c .)" -eq 5 ]] \
  || fail "all five files must still be planned despite the imbalance"

# Each batch must be independently reviewable: own files present, others absent.
FAN_FIRST="$(printf '%s\n' "$FAN_PLAN" | head -1)"
FAN_FIRST_CTX="$(cd "$FAN" && FERRET_FILES="$FAN_FIRST" bash "$ROOT/scripts/collect-context.sh" "$FAN_BASE" 2>/dev/null)"
while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  assert_contains "$FAN_FIRST_CTX" "+++ b/$f"
done < <(printf '%s\n' "$FAN_FIRST" | tr ':' '\n' | grep .)
while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  [[ "$FAN_FIRST_CTX" != *"+++ b/$f"* ]] || fail "batch leaked a file from another batch: $f"
done < <(printf '%s\n' "$FAN_PLAN" | tail -n +2 | tr ':' '\n' | grep .)

# No subagent surface may exist anywhere in the plugin. This is the assertion
# that keeps the fan-out from coming back: it failed twice, once by collecting
# the diff per agent and once by covering a fifth of the file x vector matrix.
[[ ! -e "$ROOT/agents" ]] || fail "agents/ must not exist: reviews run in one context"
# The reviewer agent must be gone from every prompt surface, and no file may
# instruct a dispatch. "subagent" is allowed only inside the prohibition, so
# match the imperative forms rather than the bare word.
for f in "$ROOT/commands/review.md" "$ROOT/commands/precommit.md" \
         "$ROOT/commands/triage.md" "$ROOT/skills/code-ferret/SKILL.md"; do
  [[ "$(grep -ci 'ferret-reviewer' "$f")" -eq 0 ]] \
    || fail "$(basename "$f") still references the deleted ferret-reviewer agent"
  # Drop negated lines first, so the prohibitions themselves do not trip this.
  # Line-based rather than sed -I: BSD sed has no case-insensitive substitute
  # flag, so the pattern silently no-ops on macOS and the check passes blind.
  [[ "$(grep -viE "never|do not|don't|must not" "$f" \
        | grep -ciE 'fan out to|fan-out to|dispatch (a |an |the )?(sub)?agent|spawn (a |an )?(sub)?agent|one per vector|one per (file )?shard')" -eq 0 ]] \
    || fail "$(basename "$f") still instructs a subagent dispatch"
done
grep -qi 'Never dispatch subagents' "$ROOT/commands/review.md" \
  || fail "/review must explicitly forbid dispatching subagents"
grep -qi 'sequential batches' "$ROOT/commands/review.md" \
  || fail "/review must describe sequential batching for large diffs"

python3 "$ROOT/tests/test_run_tools.py"

printf 'CodeFerret shell integration tests passed.\n'
