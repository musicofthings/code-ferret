#!/usr/bin/env bash
# Claude Code PreToolUse hook: blocks `git commit` when staged changes contain
# credentials. Receives the hook JSON payload on stdin; exit 2 blocks the tool.
set -uo pipefail

PAYLOAD="$(cat)"
COMMAND="$(printf '%s' "$PAYLOAD" | python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
    print(data.get("tool_input", {}).get("command", ""))
except Exception:
    pass
')"

case "$COMMAND" in
  *"git commit"*) ;;
  *) exit 0 ;;
esac

git rev-parse --show-toplevel >/dev/null 2>&1 || exit 0

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RESULT="$(bash "$SCRIPT_DIR/scan-secrets.sh" staged 2>/dev/null)"
if [[ "$RESULT" == *"SECRETS_DETECTED"* ]]; then
  {
    echo "CodeFerret blocked this commit: potential credentials in staged changes."
    echo "$RESULT" | grep '^SECRET' || true
    echo "Remove or redact the secrets, or run /code-ferret:precommit for a full pre-commit review."
  } >&2
  exit 2
fi
exit 0
