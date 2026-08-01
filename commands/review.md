---
description: Run a full CodeFerret semantic review of the current diff (working tree, staged, or against a base branch)
argument-hint: "[staged | head | <base-branch>] (default: head)"
---

Run a full CodeFerret review. Load the `code-ferret` skill and follow its
methodology exactly. Target: `$ARGUMENTS` (default `head` = uncommitted changes
vs HEAD; `staged` = index only; anything else is treated as a base ref, e.g.
`main` reviews `main...HEAD`).

Steps:

1. Collect context ONCE, to a file — never inline into the transcript:

   ```
   FERRET_OUT=.ferret/context.txt FERRET_SKIP_GUIDELINES=1 \
     bash ${CLAUDE_PLUGIN_ROOT}/scripts/collect-context.sh <target>
   ```

   This prints only a FERRET_INDEX (section line ranges + changed files),
   typically a few hundred tokens; the payload stays on disk. If the changed
   file list is empty, say so and stop.

   `FERRET_SKIP_GUIDELINES=1` omits AGENTS.md/CLAUDE.md bodies because the
   session already has them; drop that flag only if they are genuinely absent
   from your context.

2. Run installed analyzers:
   `python3 ${CLAUDE_PLUGIN_ROOT}/scripts/run_tools.py <target>`
   Read `.ferret/tool-results.json`. Continue if a tool is missing, times out,
   or errors, but disclose that status. Treat analyzer findings as evidence and
   deduplicate equivalent semantic findings instead of reporting them twice.

3. Read the diff from `.ferret/context.txt` using the index line ranges —
   Read the `FERRET_DIFF` range, not the whole file. The diff already carries
   surrounding lexical scope, so do NOT re-open changed files wholesale; open a
   file only to see a call site or definition the diff does not contain. Use
   the FERRET_FILE_HISTORY range to spot regressions of previously fixed bugs.

4. Analyze every hunk against all five vectors
   (skill references/detection-vectors.md): LOGIC, SECURITY, CONCURRENCY,
   PERFORMANCE, API.

   **Do this yourself. Never dispatch subagents for a review.** Every agent
   starts cold, re-derives context you already hold, and re-reads shared files,
   so a parallel review costs multiples of a sequential one for the same
   findings. There is no diff size at which spawning reviewers is the right
   call.

   For a large diff, work through it in **sequential batches** within this
   context rather than all at once:

   ```
   bash ${CLAUDE_PLUGIN_ROOT}/scripts/plan-shards.sh <target> <n>
   ```

   It prints one colon-joined file list per line, balanced by diff size. Read
   each batch's slice of `.ferret/context.txt` in turn, note its findings, then
   move to the next. Same coverage, one context, no duplicated setup.

   A small diff needs no batching at all — read the whole `FERRET_DIFF` range
   and review it in one pass.

5. Filter noise:
   - Drop findings a configured linter already enforces.
   - For each remaining finding run
     `python3 ${CLAUDE_PLUGIN_ROOT}/scripts/fp_cache.py check <file> <vector> "<message>"`
     and drop suppressed ones (count them for the tally).
   - Assign severity and confidence per the skill's calibration rules.

6. For each finding with a safe mechanical fix, construct a unified diff patch
   and verify it applies cleanly with `git apply --check` (use a temp file in
   the scratchpad; do NOT modify the working tree in this command).

7. Write the findings JSON to `.ferret/last-review.json` (schema:
   skill references/output-schema.md), including `codegen_instructions` on
   every finding. Also write `.ferret/last-prompts.json` and append one line to
   `.ferret/history.jsonl` per that same reference. Then print the terminal
   report: findings ordered CRITICAL → WARNING → SUGGESTION with clickable
   `file:line:col` locations, and the closing tally including suppressed and
   deduped counts.

8. If any finding has a patch, end with:
   "Run /code-ferret:triage to step through findings and apply fixes."
