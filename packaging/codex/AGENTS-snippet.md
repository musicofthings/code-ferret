# CodeFerret code review

When asked to review code changes, hunt bugs, or run a pre-commit check, use
the `code-ferret` MCP server: read `ferret_methodology` first, collect the
diff with `ferret_collect_context`, gather evidence with
`ferret_run_analyzers` and `ferret_scan_secrets`, and check every candidate
finding against `ferret_fp_cache` before reporting. Analyze five vectors —
LOGIC, SECURITY, CONCURRENCY, PERFORMANCE, API — and only report issues caused
by the diff, each with a concrete failure scenario, severity
(CRITICAL/WARNING/SUGGESTION), and confidence (HIGH/MEDIUM/LOW). Never report
style issues a linter would catch. Redact credentials as [REDACTED_SECRET].
