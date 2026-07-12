# Output Schema

Every review produces two artifacts: a human-readable terminal report and a
machine-readable findings file at `.ferret/last-review.json`.

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
      "suppression_hash": "sha256-of-normalized-pattern"
    }
  ]
}
```

Field rules:

- `severity`: `CRITICAL` | `WARNING` | `SUGGESTION` (see detection-vectors.md).
- `vector`: `LOGIC` | `SECURITY` | `CONCURRENCY` | `PERFORMANCE` | `API`.
- `confidence`: `HIGH` | `MEDIUM` | `LOW`.
- `patch`: a valid unified diff applyable with `git apply`, or `null` when no
  safe mechanical fix exists. Never emit a patch you have not verified applies
  to the current working tree.
- `suppression_hash`: output of
  `python3 ${CLAUDE_PLUGIN_ROOT}/scripts/fp_cache.py hash <file> <vector> "<message>"`.
- `explanation` must state the concrete failure scenario (inputs/state → wrong
  outcome), not restate the message.

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
