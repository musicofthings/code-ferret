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

UNTRACKED=()
if [[ "$MODE" == "head" ]]; then
  UNTRACKED_ARGS=(--others --exclude-standard -z)
  if [[ -f .ferretignore ]]; then
    UNTRACKED_ARGS+=(--exclude-from=.ferretignore)
  fi
  while IFS= read -r -d '' file; do
    UNTRACKED+=("$file")
  done < <(git ls-files "${UNTRACKED_ARGS[@]}")
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
git diff "${DIFF_ARGS[@]}" --name-status -- . "${EXCLUDES[@]+"${EXCLUDES[@]}"}"
for file in "${UNTRACKED[@]}"; do
  printf 'A\t%s\n' "$file"
done

echo "=== FERRET_DEPENDENCY_MANIFESTS ==="
git diff "${DIFF_ARGS[@]}" --name-only -- . "${EXCLUDES[@]+"${EXCLUDES[@]}"}" \
  | grep -E '(^|/)(package\.json|package-lock\.json|requirements.*\.txt|pyproject\.toml|go\.(mod|sum)|Cargo\.(toml|lock)|Gemfile|pom\.xml|build\.gradle.*)$' \
  || true
for file in "${UNTRACKED[@]}"; do
  if [[ "$file" =~ (^|/)(package\.json|package-lock\.json|requirements.*\.txt|pyproject\.toml|go\.(mod|sum)|Cargo\.(toml|lock)|Gemfile|pom\.xml|build\.gradle.*)$ ]]; then
    printf '%s\n' "$file"
  fi
done

echo "=== FERRET_FILE_HISTORY ==="
git diff "${DIFF_ARGS[@]}" --name-only -- . "${EXCLUDES[@]+"${EXCLUDES[@]}"}" | while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  echo "--- $f"
  git log --oneline -n 5 --follow -- "$f" 2>/dev/null || echo "(no history)"
done

echo "=== FERRET_DIFF ==="
git diff "${DIFF_ARGS[@]}" -U50 --no-color -- . "${EXCLUDES[@]+"${EXCLUDES[@]}"}"
for file in "${UNTRACKED[@]}"; do
  git diff --no-index -U50 --no-color -- /dev/null "$file" || status=$?
  if [[ "${status:-0}" -gt 1 ]]; then
    echo "error: failed to diff untracked file: $file" >&2
    exit 2
  fi
  unset status
done

echo "=== FERRET_END ==="
