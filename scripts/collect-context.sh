#!/usr/bin/env bash
# CodeFerret context collector.
# Usage: collect-context.sh [staged|head|<base-ref>]
# Emits: scoped diff (50 lines of context), changed files, per-file recent
# history, and touched dependency manifests. Honors .ferretignore.
set -euo pipefail

MODE="${1:-head}"
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "error: not inside a git repository" >&2
  exit 1
}
cd "$REPO_ROOT"

DIFF_ARGS=()
case "$MODE" in
  staged) DIFF_ARGS=(--cached) ;;
  head)   DIFF_ARGS=(HEAD) ;;
  *)      DIFF_ARGS=("$MODE"...HEAD) ;;
esac

EXCLUDES=()
if [[ -f .ferretignore ]]; then
  while IFS= read -r line; do
    line="${line%%#*}"
    line="$(echo "$line" | xargs)"
    [[ -z "$line" ]] && continue
    EXCLUDES+=(":(exclude)$line")
  done < .ferretignore
fi

echo "=== FERRET_META ==="
echo "mode: $MODE"
echo "repo: $REPO_ROOT"
echo "branch: $(git rev-parse --abbrev-ref HEAD)"
echo "ferretignore_patterns: ${#EXCLUDES[@]}"

echo "=== FERRET_CHANGED_FILES ==="
git diff "${DIFF_ARGS[@]}" --name-status -- . "${EXCLUDES[@]+"${EXCLUDES[@]}"}" || true

echo "=== FERRET_DEPENDENCY_MANIFESTS ==="
git diff "${DIFF_ARGS[@]}" --name-only -- . "${EXCLUDES[@]+"${EXCLUDES[@]}"}" \
  | grep -E '(^|/)(package\.json|package-lock\.json|requirements.*\.txt|pyproject\.toml|go\.(mod|sum)|Cargo\.(toml|lock)|Gemfile|pom\.xml|build\.gradle.*)$' \
  || echo "(none)"

echo "=== FERRET_FILE_HISTORY ==="
git diff "${DIFF_ARGS[@]}" --name-only -- . "${EXCLUDES[@]+"${EXCLUDES[@]}"}" | while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  echo "--- $f"
  git log --oneline -n 5 --follow -- "$f" 2>/dev/null || echo "(no history)"
done

echo "=== FERRET_DIFF ==="
git diff "${DIFF_ARGS[@]}" -U50 --no-color -- . "${EXCLUDES[@]+"${EXCLUDES[@]}"}" || true

echo "=== FERRET_END ==="
