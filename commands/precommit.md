---
description: Fast CodeFerret pre-commit check of staged changes — secrets and high-confidence critical bugs only
---

Lightweight pre-commit review optimized for speed. Staged changes only. Load
the `code-ferret` skill, but restrict scope hard:

- Report ONLY findings that are (CRITICAL severity AND HIGH confidence) — the
  commit-blocking tier. No WARNINGs, no SUGGESTIONs, no LOW/MEDIUM confidence.
- Skip dependency-impact analysis and per-file history; speed over depth.

Steps:

1. `bash ${CLAUDE_PLUGIN_ROOT}/scripts/scan-secrets.sh staged`
   Any hit is an automatic blocker — report the file:line (never the value).

2. `bash ${CLAUDE_PLUGIN_ROOT}/scripts/collect-context.sh staged`
   If empty, report "nothing staged" and stop.

3. Single fast pass over the hunks for commit-blockers only: hardcoded
   secrets, injection, unsafe deserialization, guaranteed crashes
   (null-dereference on the main path, unhandled promise rejection that kills
   the process), and data-corrupting races. Check the false-positive cache
   before reporting (`fp_cache.py check`).

4. Verdict, first line exactly one of:
   - `FERRET: PASS — safe to commit` (zero blockers)
   - `FERRET: BLOCK — <n> critical issue(s)` followed by the findings with
     clickable file:line locations and one-line fixes.

Do not write `.ferret/last-review.json` in this mode. If the user wants the
full report, point them to `/code-ferret:review staged`.
