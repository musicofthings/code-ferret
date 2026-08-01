# Changelog

## 0.3.0 — Review cost and context fidelity

This release cuts the token cost of a review by roughly an order of magnitude
while giving the reviewer *more* of the code it needs, not less. Measured on a
33-file diff with a five-vector fan-out: **~480k tokens on Opus → ~40k on
Sonnet (12x)**.

### Fixed

- **Fan-out collected the diff once per agent.** `ferret-reviewer` instructed
  every vector agent to run `collect-context.sh` itself, and the orchestrator
  ran it too — so a five-vector review paid for the same diff six times. The
  orchestrator now collects once and hands agents a shared context file plus a
  file subset.

- **Enclosing functions were being truncated.** Context was a fixed `-U50`
  window. Measured against `git diff -W` across 87 changed source files, that
  showed only 94% of enclosing-function lines on average — and collapsed to
  **17.8%** for an edit inside a 617-line function. Reviews now default to
  `git -W`, which emits the complete enclosing function (100%) and bounds at
  the function edge instead of spilling past it. This is a correctness fix, not
  an optimization; no token metric would have surfaced it.

- **`ferret-reviewer` had no model pin,** so five parallel vector agents each
  inherited the session model. Now `model: sonnet`, `effort: high`.

- **`/code-ferret:precommit` was not actually light.** It advertised "speed
  over depth" but invoked the collector at full depth with complete per-file
  history. It now sets `FERRET_LIGHT=1`, skips analyzers, and never fans out.

- **The diff was read twice.** Both the skill and `/review` told the model to
  re-open each changed file for its enclosing scope — which the diff already
  contained. Rewritten to read the diff and open files only for call sites or
  definitions the diff does not carry.

- **Repository guidelines were duplicated.** `AGENTS.md`/`CLAUDE.md` bodies were
  read into context that already held them.

- **Analyzer output was capped at 50,000 characters per tool** (~12.5k tokens
  each). Now 8,000 by default, truncated head+tail so linter summary lines
  survive.

- **`FERRET_FILES` dropped the last file in its list.** `printf '%s'` emitted no
  trailing newline, so the final `read` returned non-zero and its loop body
  never ran — one file per shard would have gone unreviewed.

### Added

- `scripts/plan-shards.sh` — splits a diff into balanced shards using
  longest-processing-time-first bin packing. Round-robin by filename routinely
  put 60% of a diff in one shard; on a 33-file diff the fattest shard dropped
  from 148 KB to 39 KB.

- `FERRET_OUT` — writes the collected payload to a file and prints only an
  index of section line ranges. Orchestrator stdout drops from ~250 KB to
  ~1 KB (231x).

- Lockfile hunks omitted by default across 12 formats (`package-lock.json`,
  `yarn.lock`, `pnpm-lock.yaml`, `npm-shrinkwrap.json`, `bun.lockb`,
  `Cargo.lock`, `go.sum`, `poetry.lock`, `Pipfile.lock`, `Gemfile.lock`,
  `composer.lock`, `uv.lock`). Names are retained, so dependency version-bump
  analysis is unaffected. `FERRET_INCLUDE_LOCKFILES=1` restores them.

- New collector controls: `FERRET_FUNCTION_CONTEXT`, `FERRET_CONTEXT_LINES`,
  `FERRET_FILES`, `FERRET_SKIP_GUIDELINES`, `FERRET_MAX_TOOL_OUTPUT`.

- A "Cost discipline" section in the skill, so the methodology itself states
  the collect-once / shard / don't-re-read rules.

### Testing

- 12 new shell assertions covering `FERRET_OUT`, `FERRET_FILES` (both ends of
  the list), `FERRET_SKIP_GUIDELINES`, lockfile suppression and opt-in,
  function-context on/off/light, and shard partitioning.
- A coverage eval across 5 repositories x 3 diff depths x 4 shard counts
  (144 checks) confirms no changed file is lost between git, the shard plan,
  and the collected context, and that `plan-shards.sh` and `collect-context.sh`
  agree on mode semantics.

### Notes

`git -W` costs about 12% more than `-U50` in aggregate. Given the other
reductions, complete function context is worth that margin. Set
`FERRET_FUNCTION_CONTEXT=0` to opt out.
