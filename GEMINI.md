# CodeFerret

CodeFerret is a diff-scoped semantic code reviewer. It hunts deep architectural
flaws across five detection vectors — LOGIC, SECURITY, CONCURRENCY,
PERFORMANCE, API — and never reports style issues a linter would catch.

Use the `code-ferret` MCP server tools when reviewing code:

- `ferret_methodology` — read the full review methodology first.
- `ferret_collect_context` — scoped diff, changed files, history, config, and
  repository guidelines for a diff target (`staged`, `head`, or a base ref).
- `ferret_run_analyzers` — bounded run of installed linters/type-checkers/
  security tools; use results as evidence and deduplicate.
- `ferret_scan_secrets` — credential scan of added diff lines; never echo
  secret values, report locations only.
- `ferret_fp_cache` — check/add false-positive suppressions shared with the
  team via `.ferret/review-cache.json`.

Slash commands: `/ferret:review [staged|head|<base>]`, `/ferret:precommit`,
`/ferret:triage`. Every finding needs a concrete failure scenario, a severity
(CRITICAL/WARNING/SUGGESTION), and a confidence rating (HIGH/MEDIUM/LOW).

Setup note: the MCP server needs its dependencies installed once —
`npm install` inside the extension's `mcp-server/` directory.
