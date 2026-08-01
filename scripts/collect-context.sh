#!/usr/bin/env bash
# CodeFerret context collector.
# Usage: collect-context.sh [staged|head|uncommitted|all|<base-ref>]
# Emits: scoped diff (12 lines of context, or 6 with FERRET_LIGHT=1), changed
# files, per-file recent history, and touched dependency manifests. Honors
# .ferretignore.
# Env vars:
#   FERRET_BASE_REF          base ref for "all" mode (default: main)
#   FERRET_INCLUDE_UNTRACKED force untracked-file inclusion for any mode
#   FERRET_LIGHT             reduce diff context and skip file history
#   FERRET_DIR_PATHSPEC      restrict every diff/file-list to this subtree
#                            (default: "." = the whole repository)
#   FERRET_CONTEXT_LINES     override diff context lines (default 12, light 6)
#   FERRET_FILES             newline/colon-separated file subset; restricts the
#                            diff to exactly these paths (fan-out sharding)
#   FERRET_SKIP_GUIDELINES   omit AGENTS.md/CLAUDE.md/.cursorrules bodies; the
#                            host agent already has them in its prompt
#   FERRET_OUT               write the payload to this path and print only a
#                            compact index (section byte offsets) to stdout
#   FERRET_INCLUDE_LOCKFILES keep lockfile hunks in the diff (default: names
#                            only -- their bodies are unreviewable bulk)
#   FERRET_FUNCTION_CONTEXT  1 (default, except light mode) = git -W, showing
#                            each hunk's COMPLETE enclosing function. 0 = fixed
#                            -U count, cheaper but truncates large functions.
set -euo pipefail

MODE="${1:-head}"
BASE_REF="${FERRET_BASE_REF:-main}"
LIGHT="${FERRET_LIGHT:-0}"
DIR_PATHSPEC="${FERRET_DIR_PATHSPEC:-.}"
[[ -z "$DIR_PATHSPEC" ]] && DIR_PATHSPEC="."
CONTEXT_LINES="${FERRET_CONTEXT_LINES:-12}"
if [[ "$LIGHT" == "1" && -z "${FERRET_CONTEXT_LINES:-}" ]]; then
  CONTEXT_LINES=6
fi

# A fixed context count cannot express "the enclosing function". Measured on a
# real edit inside a 617-line function, -U12 showed 5.5% of that function and
# -U50 only 17.8% -- not enough to trace a failure through it, which is the
# whole job. git's -W emits exactly the enclosing function: 100% coverage, and
# it BOUNDS at the function edge rather than spilling past it, so it is often
# smaller than -U50 on big hunks (aggregate ~+12% vs -U50, ~+20% vs -U12).
# Correctness wins over that margin here, so -W is the default; light mode
# still uses a fixed count because it trades depth for speed by design.
FUNC_CONTEXT=()
FUNC_CONTEXT_DEFAULT=1
[[ "$LIGHT" == "1" ]] && FUNC_CONTEXT_DEFAULT=0
if [[ "${FERRET_FUNCTION_CONTEXT:-$FUNC_CONTEXT_DEFAULT}" == "1" ]]; then
  FUNC_CONTEXT=(-W)
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

# FERRET_FILES shards the diff across parallel vector reviewers so each one
# collects only its slice instead of the whole payload.
PATHSPECS=()
if [[ -n "${FERRET_FILES:-}" ]]; then
  while IFS= read -r f; do
    [[ -z "$f" ]] && continue
    PATHSPECS+=(":(literal)$f")
  done < <(printf '%s\n' "${FERRET_FILES}" | tr ':' '\n')
fi
if [[ "${#PATHSPECS[@]}" -eq 0 ]]; then
  PATHSPECS=("$DIR_PATHSPEC")
fi

EXCLUDES=()
if [[ -f .ferretignore ]]; then
  while IFS= read -r line; do
    line="${line%%#*}"
    line="$(echo "$line" | xargs)"
    [[ -z "$line" ]] && continue
    EXCLUDES+=(":(exclude)$line")
  done < .ferretignore
fi

# Lockfile bodies are the single largest source of dead weight in a diff --
# tens of thousands of machine-generated lines that no semantic vector can find
# a bug in. Their *names* still reach FERRET_DEPENDENCY_MANIFESTS and
# FERRET_CHANGED_FILES, so the dependency version-bump check is unaffected;
# only the diff hunks are suppressed. Set FERRET_INCLUDE_LOCKFILES=1 to keep
# them (e.g. when auditing a suspected dependency-confusion attack).
DIFF_EXCLUDES=()
if [[ "${FERRET_INCLUDE_LOCKFILES:-0}" != "1" ]]; then
  for lock in package-lock.json yarn.lock pnpm-lock.yaml npm-shrinkwrap.json \
              bun.lockb Cargo.lock go.sum poetry.lock Pipfile.lock \
              Gemfile.lock composer.lock uv.lock; do
    DIFF_EXCLUDES+=(":(exclude)**/$lock" ":(exclude)$lock")
  done
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
  done < <(git ls-files "${UNTRACKED_ARGS[@]}" -- "${PATHSPECS[@]}")
fi

# With FERRET_OUT the payload goes to a file and stdout carries only an index,
# so a fan-out orchestrator pays for the diff once instead of once per agent.
if [[ -n "${FERRET_OUT:-}" ]]; then
  mkdir -p "$(dirname "$FERRET_OUT")"
  exec 3>&1 1>"$FERRET_OUT"
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
    if [[ "${FERRET_SKIP_GUIDELINES:-0}" == "1" ]]; then
      echo "--- $guideline (already in host context; body omitted)"
    else
      echo "--- $guideline"
      cat "$guideline"
    fi
    GUIDELINES_FOUND=1
  fi
done
if [[ "$GUIDELINES_FOUND" -eq 0 ]]; then
  echo "(none)"
fi

echo "=== FERRET_CHANGED_FILES ==="
git diff "${DIFF_ARGS[@]}" --name-status -- "${PATHSPECS[@]}" "${EXCLUDES[@]+"${EXCLUDES[@]}"}"
# Bash 3.2 + set -u treats an empty "${ARR[@]}" as unbound; the + form is safe.
for file in ${UNTRACKED[@]+"${UNTRACKED[@]}"}; do
  printf 'A\t%s\n' "$file"
done

echo "=== FERRET_DEPENDENCY_MANIFESTS ==="
git diff "${DIFF_ARGS[@]}" --name-only -- "${PATHSPECS[@]}" "${EXCLUDES[@]+"${EXCLUDES[@]}"}" \
  | grep -E '(^|/)(package\.json|package-lock\.json|requirements.*\.txt|pyproject\.toml|go\.(mod|sum)|Cargo\.(toml|lock)|Gemfile|pom\.xml|build\.gradle.*)$' \
  || true
for file in ${UNTRACKED[@]+"${UNTRACKED[@]}"}; do
  if [[ "$file" =~ (^|/)(package\.json|package-lock\.json|requirements.*\.txt|pyproject\.toml|go\.(mod|sum)|Cargo\.(toml|lock)|Gemfile|pom\.xml|build\.gradle.*)$ ]]; then
    printf '%s\n' "$file"
  fi
done

echo "=== FERRET_FILE_HISTORY ==="
if [[ "$LIGHT" == "1" ]]; then
  echo "(skipped: light mode)"
else
  git diff "${DIFF_ARGS[@]}" --name-only -- "${PATHSPECS[@]}" "${EXCLUDES[@]+"${EXCLUDES[@]}"}" | while IFS= read -r f; do
    [[ -z "$f" ]] && continue
    echo "--- $f"
    git log --oneline -n 5 --follow -- "$f" 2>/dev/null || echo "(no history)"
  done
fi

echo "=== FERRET_DIFF ==="
SUPPRESSED_LOCKS="$(git diff "${DIFF_ARGS[@]}" --name-only -- "${PATHSPECS[@]}" \
  "${EXCLUDES[@]+"${EXCLUDES[@]}"}" \
  | grep -E '(^|/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|npm-shrinkwrap\.json|bun\.lockb|Cargo\.lock|go\.sum|poetry\.lock|Pipfile\.lock|Gemfile\.lock|composer\.lock|uv\.lock)$' || true)"
if [[ -n "$SUPPRESSED_LOCKS" && "${FERRET_INCLUDE_LOCKFILES:-0}" != "1" ]]; then
  echo "(lockfile hunks omitted; names retained above. FERRET_INCLUDE_LOCKFILES=1 to include:)"
  printf '  %s\n' $SUPPRESSED_LOCKS
fi
git diff "${DIFF_ARGS[@]}" -U"$CONTEXT_LINES" "${FUNC_CONTEXT[@]+"${FUNC_CONTEXT[@]}"}" \
  --no-color -- "${PATHSPECS[@]}" \
  "${EXCLUDES[@]+"${EXCLUDES[@]}"}" "${DIFF_EXCLUDES[@]+"${DIFF_EXCLUDES[@]}"}"
for file in ${UNTRACKED[@]+"${UNTRACKED[@]}"}; do
  git diff --no-index -U"$CONTEXT_LINES" --no-color -- /dev/null "$file" || status=$?
  if [[ "${status:-0}" -gt 1 ]]; then
    echo "error: failed to diff untracked file: $file" >&2
    exit 2
  fi
  unset status
done

echo "=== FERRET_END ==="

if [[ -n "${FERRET_OUT:-}" ]]; then
  exec 1>&3 3>&-
  echo "=== FERRET_INDEX ==="
  echo "context_file: $FERRET_OUT"
  echo "bytes: $(wc -c < "$FERRET_OUT" | tr -d ' ')"
  echo "context_lines: $CONTEXT_LINES"
  echo "--- section line ranges (read with Read offset/limit) ---"
  grep -n '^=== FERRET_' "$FERRET_OUT" | awk -F'[:=]' '{gsub(/ /,"",$0); print}' \
    | sed 's/=== //; s/ ===//'
  echo "--- changed files ---"
  awk '/^=== FERRET_CHANGED_FILES ===$/{f=1;next} /^=== /{f=0} f' "$FERRET_OUT"
fi
