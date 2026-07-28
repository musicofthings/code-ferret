# Output Schema

Every review produces two artifacts: a human-readable terminal report and a
machine-readable findings file at `.ferret/last-review.json`.

Installed analyzer results are written separately to
`.ferret/tool-results.json`. The terminal report should summarize which tools
passed, found issues, failed, or timed out, without duplicating their findings
as semantic CodeFerret findings.

## Findings JSON (`.ferret/last-review.json`)

```json
{
  "generated_at": "2026-07-12T10:30:00Z",
  "target": "staged | head | <base-branch>",
  "findings": [
    {
      "id": "f1",
      "file": "src/controllers/payment.ts",
      "line": 84,
      "character": 14,
      "severity": "CRITICAL",
      "vector": "CONCURRENCY",
      "confidence": "HIGH",
      "message": "Potential race condition during balance debit logic.",
      "explanation": "The current implementation reads the balance and performs the deduction in separate asynchronous cycles without an atomic transaction lock. Two concurrent debits both read the same balance and the second write silently overwrites the first.",
      "patch": "--- a/src/controllers/payment.ts\n+++ b/src/controllers/payment.ts\n@@ -83,3 +83,4 @@\n-const balance = await db.getBalance(userId);\n-await db.setBalance(userId, balance - amount);\n+await db.transaction(async (tx) => {\n+  const balance = await tx.getBalanceForUpdate(userId);\n+  await tx.setBalance(userId, balance - amount);\n+});",
      "codegen_instructions": "Wrap the read-modify-write in a transaction.",
      "suppression_hash": "sha256-of-normalized-pattern"
    }
  ]
}
```

Field rules:

- `severity`: `CRITICAL` | `WARNING` | `SUGGESTION` (see detection-vectors.md).
  Case-insensitive, and the CodeRabbit wire names `MAJOR`/`MINOR` are accepted
  as `WARNING`/`SUGGESTION`. Anything else is still reported, but counted
  separately as an unrecognized severity — emit one of the three names.
- `vector`: `LOGIC` | `SECURITY` | `CONCURRENCY` | `PERFORMANCE` | `API`.
- `confidence`: `HIGH` | `MEDIUM` | `LOW`.
- `patch`: a valid unified diff applyable with `git apply`, or `null` when no
  safe mechanical fix exists. Never emit a patch you have not verified applies
  to the current working tree.
- `suppression_hash`: output of
  `python3 ${CLAUDE_PLUGIN_ROOT}/scripts/fp_cache.py hash <file> <vector> "<message>"`.
- `explanation` must state the concrete failure scenario (inputs/state → wrong
  outcome), not restate the message.
- `codegen_instructions`: imperative fix instructions aimed at a coding agent
  ("Wrap the read-modify-write in a transaction"), or `null` when no mechanical
  fix exists. Distinct from `explanation`, which states the failure scenario for
  a human. The CLI's `--agent` output falls back to `explanation` when this is
  absent.

## Terminal report

Order findings CRITICAL → WARNING → SUGGESTION, HIGH confidence first within a
tier. Format each as:

```
[CRITICAL · CONCURRENCY · HIGH] src/controllers/payment.ts:84:14
  Potential race condition during balance debit logic.
  Two concurrent debits read the same balance; the second write overwrites the first.
  Fix available — run /code-ferret:triage to apply.
```

The `path:line:col` form is mandatory so terminals render clickable links.
End the report with a one-line tally, e.g.
`2 critical · 1 warning · 3 suggestions (4 suppressed by cache, 2 deduped vs eslint)`.
Report suppressed/deduped counts honestly — silent filtering erodes trust.

## Prompt capture (`.ferret/last-prompts.json`)

Every full review also writes the prompts it used, so `ferret review
--show-prompts` can replay them without re-running analysis:

```json
{
  "generated_at": "2026-07-27T10:30:00Z",
  "target": "all",
  "prompts": [{ "name": "review", "text": "<the full prompt text>" }]
}
```

## Review history (`.ferret/history.jsonl`)

One JSON object per completed review, appended:

```json
{"ts":"2026-07-27T10:30:00Z","target":"all","branch":"main","commit":"abc1234",
 "by_severity":{"CRITICAL":1,"WARNING":2,"SUGGESTION":0},
 "by_vector":{"CONCURRENCY":1,"LOGIC":2},
 "suppressed":1,"deduped":2,"duration_ms":42000,"agent":"claude","light":false}
```

`by_severity` carries an extra `UNKNOWN` key when, and only when, a finding
used a severity outside the three names above. Its presence means the schema
was not followed — the findings are still counted, never dropped.

`ferret stats` aggregates this file; `ferret stats --rebuild` recomputes
`.ferret/stats.json` from it. A generated `.ferret/.gitignore` excludes
everything under `.ferret/` except `review-cache.json`, which is meant to be
committed and shared.
