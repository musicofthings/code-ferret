# CodeFerret CLI — CodeRabbit CLI feature port

_Date: 2026-07-27_
_Status: approved design_

## Goal

Give CodeFerret the CodeRabbit CLI *experience* — terminal-invocable reviews,
structured agent output, diagnostics, and review history — without CodeRabbit's
hosted service or per-file billing.

CodeRabbit charges because their servers run the model. CodeFerret is free
because it ships the methodology and delegates analysis to a model the user
already pays for. That inversion is preserved: the CLI adds **reach and
packaging**, not review capability. Review capability already exists via
`/code-ferret:review`.

## Scope

Ported (tier 1 — core value):

- `ferret review` with the full scope-flag surface
- `--agent` JSONL event stream
- `--light` fast policy
- `ferret doctor`

Ported (tier 2 — polish):

- `ferret review findings` (replay)
- `--show-prompts`
- `ferret stats` / `--rebuild`
- narrower-scope `candidates` when a diff is too large

Explicitly **not** ported:

- `cr auth login` / `logout` / `org`, org attribution, credits, pricing —
  CodeFerret is accountless; these commands exist only to service CodeRabbit's
  billing model. Provider/agent readiness is reported by `ferret doctor`
  instead.
- `cr update`, `cr skills` — `/plugin update` and `/plugin install` already
  cover these for the Claude Code distribution.

Not invented here: no findings-based exit code (CodeRabbit has none, and the
existing pre-commit secret guard already covers commit blocking).

## Architecture

New top-level `cli/` package: Node ESM, zero runtime dependencies
(`util.parseArgs` for flags, `node --test` for tests). Ships bins `ferret` and
`code-ferret`. Resolves `scripts/` and `skills/` with the same root-resolution
logic `mcp-server/server/index.js` already uses (`CODEFERRET_ROOT` override →
repo checkout → vendored fallback).

### The host-agent handoff

The load-bearing decision. A shell tool cannot extract structured findings from
an agent's prose output, so it does not try:

```
ferret review
  ├─ scope.js       resolve flags → collect-context.sh target
  │                 reject contradictory flags BEFORE any review starts
  ├─ agent.js       detect host agent → spawn with the review prompt
  │                   claude -p <prompt>    (default, first detected)
  │                   codex exec <prompt>
  │                   gemini -p <prompt>
  │                 stdout → progress/heartbeat only, never parsed for findings
  ├─ (agent writes .ferret/last-review.json per the existing methodology)
  ├─ findings.js    read that file — the real contract
  └─ events.js      plain-text report, or JSONL when --agent
```

Agent stdout is opaque. The handoff contract is the JSON file the review
methodology already produces, whose schema CodeFerret owns. This survives
wording changes in any host agent and needs one reader instead of three
fragile stream parsers.

Trade-off accepted: findings are not available until the review completes.
Mitigated by streaming the agent's progress lines through as `status` output
and emitting periodic `heartbeat` events.

Override host-agent detection with `--agent-cmd <cmd>` or `FERRET_AGENT`.

### Known risks

1. **A host agent must be installed.** No fallback — that is the price of
   requiring zero API keys. `ferret doctor` reports absence as a hard failure
   with install guidance.
2. **Non-interactive agents hit permission prompts.** `claude -p` will prompt
   for `bash` and `python3`. The CLI passes an explicit allowlist scoped to
   CodeFerret's own scripts rather than disabling permissions wholesale.
3. **Reviews consume the user's model subscription.** Every `ferret review`
   spawns a real agent session. `--light` exists to make the cheap path cheap,
   and the documented git-hook recipe stays secrets-only (pure bash, zero model
   cost) rather than defaulting to a full review.

## Command and flag surface

```
ferret [review]                  # default; plain-text output
ferret review --agent            # JSONL event stream
ferret review --light            # fast policy
ferret review findings           # replay last review, no re-analysis
ferret review --show-prompts     # print saved prompts, no re-analysis
ferret doctor                    # exit 1 on any failed check
ferret stats [--rebuild]
```

### Scope resolution

| Flag | `collect-context.sh` target | Meaning |
|---|---|---|
| *(none)* | `all` **(new)** | committed + staged + unstaged tracked |
| `--committed` | `<base>` | `base...HEAD` only |
| `--uncommitted` | `uncommitted` **(new)** | staged + unstaged tracked, no untracked |
| `--include-untracked` | adds untracked to the resolved target | |
| `--base <branch>` | sets the base ref | default: repo default branch |
| `--base-commit <sha>` | sets the base ref to a commit | |

`head` and `staged` retain their current semantics — including `head`'s
always-on untracked inclusion — so `/code-ferret:review` behavior is unchanged.
They remain plugin/MCP targets only; the CLI does not expose them as flags,
because `--uncommitted` and `--uncommitted --include-untracked` cover the same
ground with CodeRabbit's spelling.

Rejected before a review starts, matching CodeRabbit:

- `--committed` with `--uncommitted`
- `--committed` with `--include-untracked`

### Other flags

| Flag | Description |
|---|---|
| `--dir <path>` | Review directory; must contain an initialized git repository |
| `-c, --config <files...>` | Additional instruction files (e.g. `CLAUDE.md`) |
| `--agent` | JSONL event output |
| `--light` | Fast policy (see below) |
| `--show-prompts` | Print saved prompts from the last review; no new review |
| `--agent-cmd <cmd>` | Override host-agent detection (CodeFerret addition) |

### `--light` policy

CodeRabbit does not define this concretely, so CodeFerret defines it as:

- skip `run_tools.py` analyzers (the slow step)
- diff context reduced from `-U50` to `-U10`
- skip the `FERRET_FILE_HISTORY` section
- restrict analysis to the LOGIC and SECURITY vectors

### Exit codes

| Code | Condition |
|---|---|
| 0 | Success |
| 1 | Error: no host agent, not a git repository, invalid flag combination, failed `doctor` check |

`doctor` warnings appear in the report but do not produce a non-zero exit,
matching CodeRabbit.

## Data and schema

### New files under `.ferret/`

| File | Purpose |
|---|---|
| `last-prompts.json` | Prompts from the most recent review; powers `--show-prompts` |
| `history.jsonl` | One line per completed review; source of truth for stats |
| `stats.json` | Derived aggregate cache; built lazily on the first `ferret stats`, appended to after each review, and fully recomputed from `history.jsonl` by `--rebuild` |

A generated `.ferret/.gitignore` ignores everything **except**
`review-cache.json`, which is intended to be committed and shared.

`history.jsonl` line shape: timestamp, target, branch, commit SHA, counts by
severity and by vector, suppressed count, deduped count, duration in
milliseconds, agent used, and whether `--light` was set.

### Findings schema addition

One backward-compatible field on each finding in `.ferret/last-review.json`:

- `codegen_instructions` (string | null) — agent-oriented fix instructions,
  distinct from the human-facing `explanation`. Null when no mechanical fix
  shape exists.

Existing fields are unchanged. Existing consumers keep working.

### `--agent` JSONL contract

One JSON object per line on stdout. Event types: `review_context`, `status`,
`heartbeat`, `finding`, `complete`, `error`.

```json
{"type":"review_context","target":"all","branch":"main","files":12,"agent":"claude"}
{"type":"status","status":"collecting_context"}
{"type":"heartbeat","ts":"2026-07-27T16:40:00Z"}
{"type":"finding","severity":"critical","fileName":"src/pay.ts","line":84,
 "codegenInstructions":"Wrap the read-modify-write in a transaction…",
 "suggestions":["--- a/src/pay.ts\n+++ b/src/pay.ts\n@@ …"],
 "comment":"Race condition during balance debit.",
 "vector":"CONCURRENCY","confidence":"HIGH"}
{"type":"complete","status":"completed","findings":3,"suppressed":1,"deduped":2}
```

Field mapping from CodeFerret's schema to CodeRabbit's wire format:

| Wire field | Source |
|---|---|
| `severity` | `CRITICAL→critical`, `WARNING→major`, `SUGGESTION→minor` |
| `fileName` | `file` |
| `codegenInstructions` | `codegen_instructions`, falling back to `explanation` |
| `suggestions` | `[patch]`, or `[]` when `patch` is null |
| `comment` | `message` |
| `vector`, `confidence` | passed through as CodeFerret extras |

`trivial` and `info` are never emitted; the 3-tier taxonomy is authoritative
internally and the mapping is lossy by design. `comment` is always emitted
(CodeRabbit emits it only when `codegenInstructions` is empty; always emitting
is a compatible superset, since consumers fall back to `comment` only when
`codegenInstructions` is absent).

Empty diff, matching the documented contract: emit `review_context`, then
`status` with `status: "review_skipped"`, then `complete` with
`status: "review_skipped"`, `findings: 0`, `message: "No changes detected"`.
Plain mode prints a no-changes message and exits without starting a review.

### Oversized diffs

When the resolved scope exceeds `max_files` (default 50, configurable via
`reviews.max_files` in `.codeferret.yaml`), the review fails with an `error`
event carrying two additive fields:

- `candidates` — up to five mutually exclusive narrower re-run commands
  computed from the submitted file list, each with an estimated local file
  count and a fit indicator relative to `max_files`. Candidates may use
  `--committed`, `--uncommitted`, or `--dir` scopes.
- `candidatesNote` — guidance accompanying the suggestions.

The CLI never selects a candidate, splits the review, raises the limit, or
retries. Plain mode prints the equivalent "Narrower scopes found in this diff"
block. Estimates are deliberately conservative.

This is a distinct mechanism from the existing methodology's ">15 files →
review in directory-grouped batches" guidance, which instructs the agent to
subdivide a review it *is* performing. `max_files` is a hard refusal threshold
checked by the CLI before the agent is invoked at all. Both remain in force.

## Flow-back into existing surfaces

| File | Change |
|---|---|
| `scripts/collect-context.sh` | Add `all` and `uncommitted` modes; make untracked inclusion gateable; light-mode context reduction and history skip |
| `skills/code-ferret/SKILL.md` | Document the light policy, candidate suggestions, and prompt persistence |
| `skills/code-ferret/references/output-schema.md` | Document `codegen_instructions`, `last-prompts.json`, `history.jsonl` |
| `commands/review.md` | Persist prompts; append a history line on completion |
| `mcp-server/server/index.js` | Add `ferret_doctor`, `ferret_stats`, `ferret_findings` tools; extend scope args with `all` and `uncommitted` |
| `.codeferret.example.yaml` | Add `reviews.max_files` and light-policy defaults |
| `README.md` | CLI installation and usage section |
| `tests/run.sh` | Cases for the new `collect-context.sh` modes |

## Testing

**Agent invocation is always mocked, never live.** `FERRET_AGENT_CMD` points at
a fixture script that writes a canned `.ferret/last-review.json`. No test makes
a network call or spends model budget.

Covered by `node --test` in `cli/test/`:

- scope resolution for every flag combination
- rejection of contradictory flag combinations
- JSONL event shapes and ordering, including the empty-diff sequence
- severity mapping and field mapping
- candidate computation and fit indicators
- stats aggregation and `--rebuild` from `history.jsonl`
- `doctor` check results and exit-code behavior (failures exit 1, warnings do not)

Covered by `tests/run.sh`:

- `collect-context.sh` `all` and `uncommitted` modes
- untracked gating
- light-mode output shape

`node --test` is used rather than the Worker's vitest to keep `cli/`
dependency-free.

## File inventory

New:

```
cli/package.json
cli/bin/ferret.js
cli/src/index.js        command dispatch
cli/src/scope.js        flag → target resolution, conflict rejection
cli/src/agent.js        host-agent detection and invocation
cli/src/events.js       JSONL emitter
cli/src/report.js       plain-text report
cli/src/findings.js     read/replay last-review.json
cli/src/doctor.js       diagnostics
cli/src/stats.js        history aggregation
cli/src/candidates.js   narrower-scope computation
cli/src/paths.js        shared root resolution
cli/test/*.test.js
```

Modified: `scripts/collect-context.sh`, `skills/code-ferret/SKILL.md`,
`skills/code-ferret/references/output-schema.md`, `commands/review.md`,
`mcp-server/server/index.js`, `.codeferret.example.yaml`, `README.md`,
`tests/run.sh`.
