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
  *)      DIFF_ARGS=("$MODE"...HEAD) ;;
esac

git rev-parse --show-toplevel >/dev/null 2>&1 || { echo "error: not a git repository" >&2; exit 2; }

PATTERNS=(
  '(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36}'
  '(A3T[A-Z0-9]|AKIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16}'
  'sk-ant-[A-Za-z0-9_-]{20,}'
  'sk-[A-Za-z0-9]{20,}'
  'xox[pborsa]-[0-9]{10,13}-[0-9]{10,13}-[0-9A-Za-z-]{10,}'
  'AIza[0-9A-Za-z_-]{35}'
  '-----BEGIN (RSA|OPENSSH|EC|DSA|PGP) PRIVATE KEY-----'
  '(api[_-]?key|apikey|secret|token|password|passwd)["'"'"']?[[:space:]]*[:=][[:space:]]*["'"'"'][A-Za-z0-9_/+=.-]{20,}["'"'"']'
)
REGEX="$(IFS='|'; echo "${PATTERNS[*]}")"

FOUND=0
CURRENT_FILE=""
LINE_NO=0
while IFS= read -r line; do
  case "$line" in
    +++\ b/*)
      CURRENT_FILE="${line#+++ b/}" ;;
    @@*)
      LINE_NO="$(echo "$line" | sed -E 's/^@@ -[0-9,]+ \+([0-9]+).*/\1/')" ;;
    +*)
      content="${line#+}"
      if echo "$content" | grep -qEi "$REGEX"; then
        echo "SECRET ${CURRENT_FILE}:${LINE_NO}: potential credential on added line"
        FOUND=1
      fi
      LINE_NO=$((LINE_NO + 1)) ;;
    -*) ;;
    *)
      LINE_NO=$((LINE_NO + 1)) ;;
  esac
done < <(git diff "${DIFF_ARGS[@]}" --no-color -U0)

if [[ "$FOUND" -eq 1 ]]; then
  echo "result: SECRETS_DETECTED"
  exit 1
fi
echo "result: CLEAN"
exit 0
