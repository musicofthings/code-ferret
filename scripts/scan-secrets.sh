#!/usr/bin/env bash
# CodeFerret secret scanner. Scans added lines of a diff for high-entropy
# credentials and known token formats.
# Usage: scan-secrets.sh [staged|head|<base-ref>]
# Exit: 0 = clean, 1 = secrets found, 2 = usage/environment error
set -uo pipefail

MODE="${1:-staged}"
case "$MODE" in
  staged) DIFF_ARGS=(--cached) ;;
  head)   DIFF_ARGS=(HEAD) ;;
  *)
    if ! git rev-parse --verify "${MODE}^{commit}" >/dev/null 2>&1; then
      echo "error: unknown base ref: $MODE" >&2
      exit 2
    fi
    DIFF_ARGS=("$MODE"...HEAD)
    ;;
esac

git rev-parse --show-toplevel >/dev/null 2>&1 || { echo "error: not a git repository" >&2; exit 2; }

# Structurally unambiguous credentials. A match here is a credential by shape,
# so it is never second-guessed -- not even when the value contains a word like
# "EXAMPLE" (AWS's own documented sample secret key does).
SPECIFIC=(
  '(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36}'
  '(A3T[A-Z0-9]|AKIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16}'
  'sk-ant-[A-Za-z0-9_-]{20,}'
  'sk-[A-Za-z0-9]{20,}'
  'xox[pborsa]-[0-9]{10,13}-[0-9]{10,13}-[0-9A-Za-z-]{10,}'
  'AIza[0-9A-Za-z_-]{35}'
  '-----BEGIN (RSA|OPENSSH|EC|DSA|PGP) PRIVATE KEY-----'
)
# Keyword-plus-value. Broad by design, so it needs the placeholder filter below.
# The keyword may sit anywhere inside the identifier, not just at its end:
# without the surrounding [A-Za-z0-9_]* this misses the canonical names for two
# of the most widely used credentials -- AWS_SECRET_ACCESS_KEY and
# STRIPE_SECRET_KEY -- because "SECRET" is followed by more identifier
# characters before the "=". DB_PASSWORD was caught only because PASSWORD
# happened to end the name.
GENERIC='[A-Za-z0-9_]*(api[_-]?key|apikey|secret|token|password|passwd)[A-Za-z0-9_]*["'"'"']?[[:space:]]*[:=][[:space:]]*["'"'"'][A-Za-z0-9_/+=.-]{20,}["'"'"']'

# Sample values in docs, .env.example files and templates are not secrets, and
# blocking a commit over one teaches people to bypass the hook. Treat a value
# as a placeholder only when it is BOTH worded like one AND lacks the character
# mix a real credential has -- "your-password-here" is caught, while a genuine
# key that happens to contain "example" keeps its uppercase, digits and
# punctuation and is still reported.
PLACEHOLDER_WORDS='your|example|placeholder|changeme|change_me|replace|redacted|dummy|sample|insert|todo|xxxx|<[a-z_]+>'

SPECIFIC_REGEX="$(IFS='|'; echo "${SPECIFIC[*]}")"
REGEX="$SPECIFIC_REGEX|$GENERIC"

is_placeholder() { # value -> 0 when it looks like sample data
  local v="$1"
  echo "$v" | grep -qEi "$PLACEHOLDER_WORDS" || return 1
  # A real credential almost always mixes cases or carries symbols beyond the
  # separators a human-written placeholder uses.
  echo "$v" | grep -qE '[A-Z]' && return 1
  echo "$v" | grep -qE '[/+=]' && return 1
  return 0
}

FOUND=0
CURRENT_FILE=""
LINE_NO=0
DIFF_OUTPUT="$(git diff "${DIFF_ARGS[@]}" --no-color -U0)" || {
  echo "error: failed to read git diff" >&2
  exit 2
}
while IFS= read -r line; do
  case "$line" in
    +++\ b/*)
      CURRENT_FILE="${line#+++ b/}" ;;
    @@*)
      LINE_NO="$(echo "$line" | sed -E 's/^@@ -[0-9,]+ \+([0-9]+).*/\1/')" ;;
    +*)
      content="${line#+}"
      if echo "$content" | grep -qEi "$SPECIFIC_REGEX"; then
        echo "SECRET ${CURRENT_FILE}:${LINE_NO}: potential credential on added line"
        FOUND=1
      elif echo "$content" | grep -qEi "$GENERIC"; then
        # Only the broad keyword rule is placeholder-filtered.
        VALUE="$(echo "$content" | sed -E 's/.*["'"'"']([A-Za-z0-9_/+=.-]{20,})["'"'"'].*/\1/')"
        if ! is_placeholder "$VALUE"; then
          echo "SECRET ${CURRENT_FILE}:${LINE_NO}: potential credential on added line"
          FOUND=1
        fi
      fi
      LINE_NO=$((LINE_NO + 1)) ;;
    -*) ;;
    *)
      LINE_NO=$((LINE_NO + 1)) ;;
  esac
done <<< "$DIFF_OUTPUT"

if [[ "$FOUND" -eq 1 ]]; then
  echo "result: SECRETS_DETECTED"
  exit 1
fi
echo "result: CLEAN"
exit 0
