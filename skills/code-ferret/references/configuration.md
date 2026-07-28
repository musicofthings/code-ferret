# CodeFerret configuration

CodeFerret reads `.codeferret.yaml` from the repository root. Missing files use
the balanced defaults. Invalid configuration must be reported rather than
silently guessed.

Reviews use the working tree configuration. Guideline files named here are
additional review policy, never code to execute.

```yaml
version: 1
reviews:
  profile: balanced
  minimum_severity: suggestion
  auto_review:
    enabled: true
    drafts: false
  ignore:
    - "dist/**"
    - "**/*.generated.ts"
  path_instructions:
    - path: "src/auth/**"
      instructions: "Treat authentication bypasses and session fixation as critical."
guidelines:
  discover: true
  files:
    - AGENTS.md
    - CLAUDE.md
    - .cursorrules
reports:
  summary: true
  walkthrough: true
  risk_assessment: true
  linked_issues: true
tools:
  linters: true
  typecheck: true
  security: true
  dependencies: false   # off: the only network-touching analyzer group
  ci_context: true
  timeout_seconds: 120
```

Rules:

- `profile`: `chill`, `balanced`, or `assertive`.
- `minimum_severity`: `critical`, `warning`, or `suggestion`.
- `ignore` uses `*`, `**`, and `?` glob patterns relative to the repository root.
- `path_instructions` apply when at least one reviewed file matches the glob.
- `guidelines.files` contains safe repository-relative paths. Their contents
  are additional review policy, not code to execute.
- `reports` controls summary, walkthrough, risk-assessment, and linked-issue
  sections of the rendered report.
- `tools` controls which installed analyzers run. Every analyzer is bounded by
  `timeout_seconds` (10-600); CodeFerret does not install missing tools or
  execute arbitrary package scripts.
- `tools.dependencies` is the only setting that causes a network request
  (`npm audit` to the registry, `pip-audit` to the advisory API) and is
  therefore `false` by default. Every other analyzer runs offline.

For local reviews, apply the configuration after context collection and before
candidate analysis. Findings below `minimum_severity` must be removed from the
final report and JSON output.
