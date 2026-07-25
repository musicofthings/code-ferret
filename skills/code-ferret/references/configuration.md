# CodeFerret configuration

CodeFerret reads `.codeferret.yaml` from the repository root. Missing files use
the balanced defaults. Invalid configuration must be reported rather than
silently guessed.

The webhook Worker loads configuration and guideline files from the pull
request's base commit, never from the untrusted head commit. A pull request
therefore cannot disable or weaken its own review policy. Local explicit reviews
use the working tree configuration.

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
  dependencies: true
  ci_context: true
  timeout_seconds: 120
```

Rules:

- `profile`: `chill`, `balanced`, or `assertive`.
- `minimum_severity`: `critical`, `warning`, or `suggestion`.
- `auto_review` controls the webhook Worker. Local commands still run when
  explicitly invoked.
- `ignore` uses `*`, `**`, and `?` glob patterns relative to the repository root.
- `path_instructions` apply when at least one reviewed file matches the glob.
- `guidelines.files` contains safe repository-relative paths. Their contents
  are additional review policy, not code to execute.
- `reports` controls PR-description summaries, walkthrough comments, risk
  assessment, and linked-issue requirement validation in the webhook Worker.
  `NOT_MET` requirements fail the Check Run; `PARTIAL` and `UNKNOWN` produce a
  neutral conclusion.
- `tools` controls installed local analyzers and Worker CI-failure context.
  Every analyzer is bounded by `timeout_seconds` (10-600); CodeFerret does not
  install missing tools or execute arbitrary package scripts.

For local reviews, apply the configuration after context collection and before
candidate analysis. Findings below `minimum_severity` must be removed from the
final report and JSON output.
