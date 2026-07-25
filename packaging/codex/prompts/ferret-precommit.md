Run a fast CodeFerret pre-commit check of the staged changes. Report ONLY
commit blockers: findings that are CRITICAL severity AND HIGH confidence, plus
secrets. No WARNINGs, no SUGGESTIONs — speed over depth.

1. Call ferret_scan_secrets (code-ferret MCP server) with target "staged".
   Any hit is an automatic blocker — report file:line, never the value.
2. Call ferret_collect_context with target "staged". If empty, report
   "nothing staged" and stop.
3. Single fast pass over the hunks for commit-blockers only: hardcoded
   secrets, injection, unsafe deserialization, guaranteed crashes, and
   data-corrupting races. Call ferret_fp_cache action "check" before
   reporting anything.
4. Verdict, first line exactly one of:
   - "FERRET: PASS — safe to commit" (zero blockers)
   - "FERRET: BLOCK — <n> critical issue(s)" followed by findings with
     file:line locations and one-line fixes.
