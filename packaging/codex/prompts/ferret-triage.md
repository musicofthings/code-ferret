Interactively triage CodeFerret findings from $ARGUMENTS (default:
.ferret/last-review.json). If the file does not exist, tell the user to run
/ferret-review first and stop.

Step through findings one at a time, ordered CRITICAL → WARNING → SUGGESTION,
HIGH confidence first. For each, present the severity/vector/confidence
header, file:line:character location, message, explanation, and patch (if
any), then ask the user to choose:

- Accept & apply patch (when one exists) — apply it; if the context drifted,
  make the equivalent edit manually, then run a cheap compile/parse check.
- Ignore pattern — call ferret_fp_cache (code-ferret MCP server) with action
  "add", the finding's file/vector/message, and the user's stated reason, so
  the pattern is suppressed in future reviews.
- Discuss — explain the concrete failure scenario and alternatives, re-ask.
- Skip — leave the finding open and move on.

Finish with a summary: applied, suppressed, skipped, and stale findings.
