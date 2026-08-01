# Changelog

## 0.4.0 — One reviewer, one context

### Removed

- **`agents/ferret-reviewer.md` is gone, and no command dispatches subagents.**
  Parallel review was a mistake twice over: 0.3.0 had every agent re-collect the
  whole diff, and 0.3.0–0.3.1 sharded by vector so the review covered a fifth of
  the file×vector matrix. Both were fixed, and the feature still was not worth
  it. Each agent starts cold, re-derives context the reviewer already holds, and
  re-reads the same shared files — a multiple of the cost for the same findings.

  Large diffs are now worked through in **sequential batches inside one
  context**. `plan-shards.sh` survives to produce those batches; it just feeds a
  loop instead of a fleet.

  This is why the plugin no longer ships an `agents/` directory at all: a
  present agent definition is a standing invitation to dispatch it.

### Fixed

- **The pre-commit guard blocked commits over placeholder values.** Sample data
  in `.env.example` files and docs (`password = "your-password-here"`) tripped
  the broad keyword rule. Blocking a commit over a non-secret teaches people to
  bypass the hook, which costs more than it saves.

  The filter applies **only** to the keyword rule, never to structurally
  unambiguous credentials, and requires the value to be both worded like a
  placeholder and missing a real credential's character mix. AWS's documented
  sample secret key contains the word `EXAMPLE`; it is still reported.

- **`plan-shards.sh` hid batch imbalance it could not fix.** A batch cannot be
  split below one file, so one dominant file caps how even a plan can get. That
  now prints a note to stderr naming the file, instead of shipping a lopsided
  plan that looks balanced. Balanced plans stay silent.

### Added

- **`evals/`** — a recall eval with planted ground truth, and `score.py` to
  grade a review against it. `tests/run.sh` checks that the machinery works;
  this checks that the review finds things. They fail independently, and the
  second is what catches design mistakes: the 0.3.0 fan-out passed every unit
  assertion while recalling 6 of 12 planted bugs.
- **`fp_cache.py` test coverage**, which was zero despite the suppression round
  trip being a headline feature. 16 assertions: the hash must survive line
  numbers, whitespace, case and directory moves, and must not collide across
  file, vector or message; a corrupt cache must degrade to "not suppressed"
  rather than take the review down.
- **triage mechanics coverage**, also previously zero, on the only command that
  writes to the working tree: patches round-trip out of `last-review.json` and
  apply, re-applying fails rather than double-patching, a drifted patch reports
  as inapplicable, and the Ignore-pattern path suppresses on re-run.
- Assertions that keep the fan-out from returning: `agents/` must not exist, and
  no command or skill may instruct a dispatch.

### Note on the token work in 0.3.x

Reviewing the transcripts that motivated it: across 120 sessions, 15 actually
invoked CodeFerret, and the collector payload attributable to it is ~0.26% of
the tokens in those sessions. The 0.3.x reductions are real and the correctness
fixes stand on their own, but CodeFerret was not the source of the token spend
it was optimised for.

## 0.3.2 — Fan-out reviewed a fifth of what it claimed

### Fixed

- **The fan-out covered 1/N of the file×vector matrix.** 0.3.0 shipped
  "one `ferret-reviewer` per vector", each handed one file shard. That reads as
  five specialists covering the diff; it is actually five specialists each
  seeing a fifth of the files and checking a fifth of the vectors. A defect
  whose vector was assigned to a different shard was never looked for.

  Shards now split by **file**, and every agent applies **all five vectors** to
  its own slice. Same token cost — each file's diff still enters exactly one
  agent's context — with full coverage instead of a fifth.

  Measured on a 23-file diff with 12 bugs planted across all five vectors,
  reviewed by five real subagents:

  | | recall |
  |---|---|
  | per-vector shards (0.3.0/0.3.1) | 6/12 (50%) |
  | per-file shards (0.3.2) | **12/12 (100%)** |

  A missed SQL injection in `auth.py` was the worst case: the file went to the
  API agent, and the SECURITY agent was never shown it. The clearest evidence
  was `cache_init.py`, where the LOGIC agent spotted the removed lock, wrote
  that it "falls under the CONCURRENCY vector, not LOGIC", and dropped it
  exactly as instructed — while no other agent would ever see that file.

  `ferret-reviewer` now states that it is the only reviewer for its files and
  must never drop a finding for belonging to another vector.

### Testing

- Six assertions pin the corrected topology: the agent must apply all five
  vectors, must say shards split by file rather than vector, and must forbid
  dropping out-of-vector findings; `/review` must fan out per file shard, must
  warn against per-vector sharding, and must no longer contain the phrase "one
  per vector". Each verified to fail under targeted sabotage.
- The collect-once contract was verified live rather than by inspection: the
  installed collector was wrapped in a logging shim for both fan-out runs, and
  recorded zero re-invocations by agents across all ten dispatches.

## 0.3.1 — Secret scanner missed mid-identifier keywords

### Fixed

- **The pre-commit secret guard did not block `AWS_SECRET_ACCESS_KEY` or
  `STRIPE_SECRET_KEY`.** The generic keyword pattern anchored the keyword
  immediately before the `=`, so it matched `DB_PASSWORD = "..."` (where
  `PASSWORD` ends the identifier) but not `AWS_SECRET_ACCESS_KEY = "..."`,
  where `SECRET` is followed by `_ACCESS_KEY`. Those are the canonical
  environment-variable names for two of the most widely used credentials, so
  the most likely real-world spelling was the one that slipped through. The
  pattern now allows identifier characters on both sides of the keyword.

  Found while running the pre-commit path against a scratch repository with a
  staged AWS key; the commit was not blocked. Present since 0.2.0.

### Testing

- 14 new assertions pin the scanner's behaviour: 11 credential shapes that must
  be caught (AWS secret key and access-key id, Stripe, GitHub, Anthropic,
  Google, RSA private key, and bare `password`/`secret`/`api_key`/`DB_PASSWORD`)
  and 3 benign lines that must not be flagged (environment-variable reference,
  short value, prose comment). Verified to fail when the fix is reverted.

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
