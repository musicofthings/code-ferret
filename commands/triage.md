---
description: Interactively triage CodeFerret findings one by one — apply patches, suppress false positives, or discuss
argument-hint: "[path to findings JSON] (default: .ferret/last-review.json)"
---

Interactive triage of CodeFerret findings. Load the `code-ferret` skill for
schema context.

1. Read the findings file (`$ARGUMENTS` or `.ferret/last-review.json`). If it
   does not exist, tell the user to run `/code-ferret:review` first and stop.
   Skip findings whose file/line no longer match the working tree (note them
   as stale in the final summary).

2. Step through findings one at a time, ordered CRITICAL → WARNING →
   SUGGESTION, HIGH confidence first. For each, present:

   ```
   [<SEVERITY> · <VECTOR> · <CONFIDENCE>] <file>:<line>:<character>
   <message>
   <explanation>
   <patch, if any, as a diff block>
   ```

   Then use the AskUserQuestion tool with these options:
   - **Accept & apply patch** (only when a patch exists) — apply the fix.
   - **Ignore pattern** — suppress this finding pattern in future reviews.
   - **Discuss** — explain in depth before deciding.
   - **Skip** — leave the finding open, move on.

3. On **Accept & apply patch**: write the patch to a scratchpad file and apply
   with `git apply`; if it fails (drifted context), make the equivalent change
   with the Edit tool. Confirm the result compiles/parses if a cheap check
   exists (linter, `python -m py_compile`, `tsc --noEmit` on small projects).

4. On **Ignore pattern**: run
   `python3 ${CLAUDE_PLUGIN_ROOT}/scripts/fp_cache.py add <file> <vector> "<message>" "<user's stated reason, or 'intentional choice'>"`
   and confirm the suppression hash was recorded.

5. On **Discuss**: give a deeper explanation — the concrete failure scenario,
   why the fix is shaped that way, alternatives and trade-offs — then re-ask
   the same options for this finding.

6. After the last finding, print a summary table: applied / suppressed /
   skipped / stale, and remind the user that applied fixes are unstaged and
   uncommitted.
