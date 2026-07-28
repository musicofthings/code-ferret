#!/usr/bin/env bash
# CodeFerret context collector.
# Usage: collect-context.sh [staged|head|uncommitted|all|<base-ref>]
# Emits: scoped diff (50 lines of context, or 10 with FERRET_LIGHT=1), changed
# files, per-file recent history, and touched dependency manifests. Honors
# .ferretignore.
# Env vars:
#   FERRET_BASE_REF          base ref for "all" mode (default: main)
#   FERRET_INCLUDE_UNTRACKED force untracked-file inclusion for any mode
#   FERRET_LIGHT             reduce diff context and skip file history
#   FERRET_DIR_PATHSPEC      restrict every diff/file-list to this subtree
#                            (default: "." = the whole repository)
set -euo pipefail

MODE="${1:-head}"
BASE_REF="${FERRET_BASE_REF:-main}"
LIGHT="${FERRET_LIGHT:-0}"
DIR_PATHSPEC="${FERRET_DIR_PATHSPEC:-.}"
[[ -z "$DIR_PATHSPEC" ]] && DIR_PATHSPEC="."
CONTEXT_LINES=50
if [[ "$LIGHT" == "1" ]]; then
  CONTEXT_LINES=10
fi

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

EXCLUDES=()
if [[ -f .ferretignore ]]; then
  while IFS= read -r line; do
    line="${line%%#*}"
    line="$(echo "$line" | xargs)"
    [[ -z "$line" ]] && continue
    EXCLUDES+=(":(exclude)$line")
  done < .ferretignore
fi

INCLUDE_UNTRACKED=0
if [[ "$MODE" == "head" ]]; then
  INCLUDE_UNTRACKED=1
fi
if [[ "${FERRET_INCLUDE_UNTRACKED:-0}" == "1" ]]; then
  INCLUDE_UNTRACKED=1
fi

UNTRACKED=()
if [[ "$INCLUDE_UNTRACKED" == "1" ]]; then
  UNTRACKED_ARGS=(--others --exclude-standard -z)
  if [[ -f .ferretignore ]]; then
    UNTRACKED_ARGS+=(--exclude-from=.ferretignore)
  fi
  while IFS= read -r -d '' file; do
    UNTRACKED+=("$file")
  done < <(git ls-files "${UNTRACKED_ARGS[@]}" -- "$DIR_PATHSPEC")
fi

echo "=== FERRET_META ==="
echo "mode: $MODE"
echo "repo: $REPO_ROOT"
echo "branch: $(git rev-parse --abbrev-ref HEAD)"
echo "ferretignore_patterns: ${#EXCLUDES[@]}"

echo "=== FERRET_CONFIG ==="
if [[ -f .codeferret.yaml ]]; then
  cat .codeferret.yaml
else
  echo "(defaults)"
fi

echo "=== FERRET_REPOSITORY_GUIDELINES ==="
GUIDELINES_FOUND=0
for guideline in AGENTS.md CLAUDE.md .cursorrules; do
  if [[ -f "$guideline" ]]; then
    echo "--- $guideline"
    cat "$guideline"
    GUIDELINES_FOUND=1
  fi
done
if [[ "$GUIDELINES_FOUND" -eq 0 ]]; then
  echo "(none)"
fi

echo "=== FERRET_CHANGED_FILES ==="
git diff "${DIFF_ARGS[@]}" --name-status -- "$DIR_PATHSPEC" "${EXCLUDES[@]+"${EXCLUDES[@]}"}"
for file in "${UNTRACKED[@]}"; do
  printf 'A\t%s\n' "$file"
done

echo "=== FERRET_DEPENDENCY_MANIFESTS ==="
git diff "${DIFF_ARGS[@]}" --name-only -- "$DIR_PATHSPEC" "${EXCLUDES[@]+"${EXCLUDES[@]}"}" \
  | grep -E '(^|/)(package\.json|package-lock\.json|requirements.*\.txt|pyproject\.toml|go\.(mod|sum)|Cargo\.(toml|lock)|Gemfile|pom\.xml|build\.gradle.*)$' \
  || true
for file in "${UNTRACKED[@]}"; do
  if [[ "$file" =~ (^|/)(package\.json|package-lock\.json|requirements.*\.txt|pyproject\.toml|go\.(mod|sum)|Cargo\.(toml|lock)|Gemfile|pom\.xml|build\.gradle.*)$ ]]; then
    printf '%s\n' "$file"
  fi
done

echo "=== FERRET_FILE_HISTORY ==="
if [[ "$LIGHT" == "1" ]]; then
  echo "(skipped: light mode)"
else
  git diff "${DIFF_ARGS[@]}" --name-only -- "$DIR_PATHSPEC" "${EXCLUDES[@]+"${EXCLUDES[@]}"}" | while IFS= read -r f; do
    [[ -z "$f" ]] && continue
    echo "--- $f"
    git log --oneline -n 5 --follow -- "$f" 2>/dev/null || echo "(no history)"
  done
fi

echo "=== FERRET_DIFF ==="
git diff "${DIFF_ARGS[@]}" -U"$CONTEXT_LINES" --no-color -- "$DIR_PATHSPEC" "${EXCLUDES[@]+"${EXCLUDES[@]}"}"
for file in "${UNTRACKED[@]}"; do
  git diff --no-index -U"$CONTEXT_LINES" --no-color -- /dev/null "$file" || status=$?
  if [[ "${status:-0}" -gt 1 ]]; then
    echo "error: failed to diff untracked file: $file" >&2
    exit 2
  fi
  unset status
done

echo "=== FERRET_END ==="
