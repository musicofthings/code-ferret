#!/usr/bin/env bash
# Claude Code PreToolUse hook: blocks `git commit` when staged changes contain
# credentials. Receives the hook JSON payload on stdin; exit 2 blocks the tool.
set -uo pipefail

PAYLOAD="$(cat)"
IS_COMMIT="$(printf '%s' "$PAYLOAD" | python3 -c '
import json, os, shlex, sys

def is_git_commit(command):
    try:
        lexer = shlex.shlex(command, posix=True, punctuation_chars=";&|")
        lexer.whitespace_split = True
        tokens = list(lexer)
    except ValueError:
        return False

    separators = {";", "&&", "||", "|", "&"}
    for index, token in enumerate(tokens):
        if os.path.basename(token) != "git":
            continue
        cursor = index + 1
        while cursor < len(tokens) and tokens[cursor] not in separators:
            arg = tokens[cursor]
            if arg in {"-c", "-C", "--config-env", "--git-dir", "--work-tree", "--namespace", "--exec-path"}:
                cursor += 2
                continue
            if arg.startswith(("--git-dir=", "--work-tree=", "--namespace=", "--exec-path=")):
                cursor += 1
                continue
            if arg.startswith("-"):
                cursor += 1
                continue
            return arg == "commit"
    return False

try:
    data = json.load(sys.stdin)
    print("1" if is_git_commit(data.get("tool_input", {}).get("command", "")) else "0")
except Exception:
    print("0")
')"

[[ "$IS_COMMIT" == "1" ]] || exit 0

git rev-parse --show-toplevel >/dev/null 2>&1 || exit 0

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RESULT="$(bash "$SCRIPT_DIR/scan-secrets.sh" staged 2>&1)"
SCAN_STATUS=$?
if [[ "$SCAN_STATUS" -eq 1 ]]; then
  {
    echo "CodeFerret blocked this commit: potential credentials in staged changes."
    echo "$RESULT" | grep '^SECRET' || true
    echo "Remove or redact the secrets, or run /code-ferret:precommit for a full pre-commit review."
  } >&2
  exit 2
fi
if [[ "$SCAN_STATUS" -ne 0 ]]; then
  echo "CodeFerret blocked this commit because the secret scan failed:" >&2
  echo "$RESULT" >&2
  exit 2
fi
exit 0
