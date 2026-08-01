#!/usr/bin/env bash
# CodeFerret shard planner.
# Usage: plan-shards.sh [staged|head|uncommitted|all|<base-ref>] [shard-count]
#
# Emits one line per shard: a colon-joined file list ready to pass as
# FERRET_FILES to collect-context.sh. Shards are balanced by diff BYTES, not by
# file count -- round-robin over file names routinely puts 60% of a diff in one
# shard, which leaves the fan-out bound by its fattest agent.
#
# Env vars: FERRET_BASE_REF, FERRET_INCLUDE_UNTRACKED, FERRET_DIR_PATHSPEC
# are honored the same way collect-context.sh honors them.
set -euo pipefail

MODE="${1:-head}"
SHARDS="${2:-5}"
BASE_REF="${FERRET_BASE_REF:-main}"
DIR_PATHSPEC="${FERRET_DIR_PATHSPEC:-.}"
[[ -z "$DIR_PATHSPEC" ]] && DIR_PATHSPEC="."

if ! [[ "$SHARDS" =~ ^[0-9]+$ ]] || [[ "$SHARDS" -lt 1 ]]; then
  echo "error: shard count must be a positive integer: $SHARDS" >&2
  exit 2
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
[[ "$MODE" == "head" ]] && INCLUDE_UNTRACKED=1
[[ "${FERRET_INCLUDE_UNTRACKED:-0}" == "1" ]] && INCLUDE_UNTRACKED=1

# "<added>\t<deleted>\t<path>" per file; binary files report "-\t-".
WEIGHTS="$(git diff "${DIFF_ARGS[@]}" --numstat -- "$DIR_PATHSPEC" \
  "${EXCLUDES[@]+"${EXCLUDES[@]}"}")"

if [[ "$INCLUDE_UNTRACKED" == "1" ]]; then
  UNTRACKED_ARGS=(--others --exclude-standard -z)
  [[ -f .ferretignore ]] && UNTRACKED_ARGS+=(--exclude-from=.ferretignore)
  while IFS= read -r -d '' file; do
    lines="$(wc -l < "$file" 2>/dev/null | tr -d ' ')" || lines=0
    WEIGHTS+=$'\n'"${lines:-0}	0	${file}"
  done < <(git ls-files "${UNTRACKED_ARGS[@]}" -- "$DIR_PATHSPEC")
fi

printf '%s\n' "$WEIGHTS" \
  | SHARDS="$SHARDS" INCLUDE_LOCKFILES="${FERRET_INCLUDE_LOCKFILES:-0}" python3 -c '
import os, posixpath, sys

shards = int(os.environ["SHARDS"])
# Mirrors collect-context.sh: lockfile hunks are stripped from the diff, so
# weighting them would reserve a shard for a file carrying no reviewable bytes.
LOCKFILES = {
    "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "npm-shrinkwrap.json",
    "bun.lockb", "Cargo.lock", "go.sum", "poetry.lock", "Pipfile.lock",
    "Gemfile.lock", "composer.lock", "uv.lock",
}
skip_locks = os.environ.get("INCLUDE_LOCKFILES", "0") != "1"

files = []
for raw in sys.stdin.read().splitlines():
    if not raw.strip():
        continue
    parts = raw.split("\t")
    if len(parts) < 3:
        continue
    added, deleted, path = parts[0], parts[1], "\t".join(parts[2:])
    if not path:
        continue
    if skip_locks and posixpath.basename(path) in LOCKFILES:
        continue
    # Binary files show "-"; give them a nonzero floor so they still get placed.
    weight = sum(int(v) for v in (added, deleted) if v.isdigit()) or 1
    files.append((weight, path))

if not files:
    sys.exit(0)

# Longest-processing-time-first bin packing: sort heavy files first, then drop
# each into whichever shard is currently lightest.
files.sort(key=lambda fp: (-fp[0], fp[1]))
bins = [[0, []] for _ in range(min(shards, len(files)))]
for weight, path in files:
    target = min(bins, key=lambda b: b[0])
    target[0] += weight
    target[1].append(path)

for total, paths in bins:
    print(":".join(paths))

# A batch cannot be split below one file, so a single dominant file sets the
# floor no matter how many batches are requested. Say so on stderr rather than
# emitting a lopsided plan that looks balanced.
grand = sum(w for w, _ in files)
heaviest, heaviest_path = max(files)
biggest_bin = max(b[0] for b in bins)
if grand and biggest_bin > grand / len(bins) * 1.5:
    pct = 100 * biggest_bin / grand
    if heaviest > grand / len(bins):
        print(f"note: {heaviest_path} alone is {100 * heaviest / grand:.0f}% of the diff; "
              f"the largest batch is {pct:.0f}% and cannot be split further. "
              f"Review that file on its own, or exclude it via .ferretignore.",
              file=sys.stderr)
    else:
        print(f"note: the largest batch is {pct:.0f}% of the diff; "
              f"batches are uneven because few files carry most of the change.",
              file=sys.stderr)
'
