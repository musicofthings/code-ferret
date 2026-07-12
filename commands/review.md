---
description: Run a full CodeFerret semantic review of the current diff (working tree, staged, or against a base branch)
argument-hint: "[staged | head | <base-branch>] (default: head)"
---

Run a full CodeFerret review. Load the `code-ferret` skill and follow its
methodology exactly. Target: `$ARGUMENTS` (default `head` = uncommitted changes
vs HEAD; `staged` = index only; anything else is treated as a base ref, e.g.
`main` reviews `main...HEAD`).

Steps:

1. Collect context:
   `bash ${CLAUDE_PLUGIN_ROOT}/scripts/collect-context.sh <target>`
   If the diff is empty, say so and stop. If it is very large (>15 files),
   review in batches grouped by directory so no hunk is skipped.

2. Read each changed file's relevant scope (enclosing functions/classes, call
   sites of changed signatures). Use the FERRET_FILE_HISTORY section to spot
   regressions of previously fixed bugs.

3. Analyze every hunk against all five vectors
   (skill references/detection-vectors.md): LOGIC, SECURITY, CONCURRENCY,
   PERFORMANCE, API.

4. Filter noise:
   - Drop findings a configured linter already enforces.
   - For each remaining finding run
     `python3 ${CLAUDE_PLUGIN_ROOT}/scripts/fp_cache.py check <file> <vector> "<message>"`
     and drop suppressed ones (count them for the tally).
   - Assign severity and confidence per the skill's calibration rules.

5. For each finding with a safe mechanical fix, construct a unified diff patch
   and verify it applies cleanly with `git apply --check` (use a temp file in
   the scratchpad; do NOT modify the working tree in this command).

6. Write the findings JSON to `.ferret/last-review.json` (schema:
   skill references/output-schema.md), then print the terminal report:
   findings ordered CRITICAL → WARNING → SUGGESTION with clickable
   `file:line:col` locations, and the closing tally including suppressed and
   deduped counts.

7. If any finding has a patch, end with:
   "Run /code-ferret:triage to step through findings and apply fixes."
