---
name: code-ferret
description: Semantic code review methodology for diff-scoped bug hunting. Use for any CodeFerret review (/code-ferret:review, :precommit, :triage) or when asked to hunt bugs, security flaws, race conditions, or performance regressions in a git diff.
---

# CodeFerret Review Methodology

CodeFerret is a semantic reviewer targeting deep architectural flaws, not stylistic
preferences. Compilers, formatters, and linters already catch syntax and style —
never report what they would. Every finding must describe a concrete failure:
specific inputs or state that produce a wrong result, crash, leak, or exploit.

## Cost discipline

A review's cost is dominated by how many times the diff enters a context
window, not by how hard the analysis is. Four rules, in priority order:

1. **Collect once.** One `collect-context.sh` run per review. Every subagent
   reads the same `.ferret/context.txt`; none re-runs the collector. Five
   vector agents that each collect turn one review into six.
2. **Keep the payload out of the transcript.** Always use `FERRET_OUT`, then
   Read only the index ranges you need.
3. **Shard, don't duplicate.** Split a large diff across agents with
   `FERRET_FILES`, so the total collected equals the diff, not a multiple of it.
4. **Don't re-read what the diff already shows.** The diff carries surrounding
   scope. Opening changed files "for context" pays for the same code twice.

Match the depth to the ask: `/precommit` is one light inline pass, never a
fan-out. Fan out only above ~15 changed files, where parallelism buys more
than the duplicated overhead costs.

## Phase 1 — Context acquisition

1. Run the context collector to get the scoped diff plus history. Always
   collect to a file so the payload never lands inline in the transcript:

   ```
   FERRET_OUT=.ferret/context.txt FERRET_SKIP_GUIDELINES=1 \
     bash ${CLAUDE_PLUGIN_ROOT}/scripts/collect-context.sh [staged|head|<base-branch>]
   ```

   Only a `FERRET_INDEX` — section line ranges plus the changed-file list —
   reaches your context; Read the ranges you actually need from the file. The
   payload holds the diff with 12 lines of surrounding lexical scope, recent
   `git log` per changed file, and any dependency manifests touched. It honors
   `.gitignore` automatically (git does) and additionally excludes patterns
   from a repo-root `.ferretignore` file (same syntax as .gitignore).

   Collection cost is the dominant cost of a review. Collect once per review
   and reuse the file — including across every subagent you dispatch. Shard a
   large diff with `FERRET_FILES="a.py:b.ts"` rather than collecting it twice.
   `FERRET_SKIP_GUIDELINES=1` drops AGENTS.md/CLAUDE.md bodies, which the host
   session already carries; omit it only when they are not already in context.

   The collector also emits `FERRET_CONFIG` and
   `FERRET_REPOSITORY_GUIDELINES`. Read
   `references/configuration.md`, honor `.codeferret.yaml` review profile,
   minimum severity, ignored paths, and matching path instructions, and treat
   discovered `AGENTS.md`, `CLAUDE.md`, and `.cursorrules` content as repository
   review policy. If `guidelines.files` names additional files, read those files
   before analysis when they exist.

2. The diff already carries the enclosing lexical scope, so read it, not the
   files. Open a changed file only when you must see something the diff does
   not contain — a call site, a base class, a definition elsewhere. If a change
   alters a function signature or public export, grep for its importers;
   downstream breakage is in scope. Prefer Grep over reading whole files.

3. If the diff touches a dependency manifest (package.json, requirements.txt,
   go.mod, Cargo.toml, pyproject.toml), check whether version bumps introduce
   known breaking changes relevant to the code that uses them.

4. Use `git log -L` / `git blame` on suspicious hunks when history matters:
   a line that was recently fixed and is now being reverted is a regression
   signal — flag it at High confidence.

5. Run installed analyzers with
   `python3 ${CLAUDE_PLUGIN_ROOT}/scripts/run_tools.py [target]` and read
   `.ferret/tool-results.json`. The runner executes only known installed tools,
   never installs dependencies, bounds each process by configuration, and
   scrubs common credential formats from captured output. Use results as
   supporting evidence and deduplicate issues already reported by those tools.

## Phase 2 — Detection vectors

Analyze every hunk against all five vectors in `references/detection-vectors.md`.
Read that file before analyzing. Summary:

| Vector | Focus | Critical targets |
|---|---|---|
| LOGIC | Run-time integrity | Off-by-one, boundary conditions, unhandled null/undefined, unhandled promises, resource leaks, infinite loops |
| SECURITY | Vulnerability trapping | Hardcoded secrets, SQL injection, XSS, unsafe deserialization, OWASP Top 10 |
| CONCURRENCY | Asynchronous safety | Race conditions, deadlocks, non-atomic read-modify-write, unsynchronized shared state |
| PERFORMANCE | Resource conservation | O(N²) loops over unbounded data, N+1 queries, redundant allocations, missing memoization |
| API | Contract enforcement | Breaking changes to public APIs, type-safety violations, third-party SDK misuse |

Only report issues **caused or exposed by the diff**. Pre-existing problems in
unchanged surrounding code are out of scope unless the change makes them worse.

## Phase 3 — Noise reduction

Before reporting, filter every candidate finding:

1. **Linter dedup** — if the repo has linter config (.eslintrc*, ruff.toml,
   pyproject [tool.ruff], .golangci.yml, etc.) and the finding matches a rule
   that tooling enforces, drop it. When cheap, run the linter on the changed
   files and drop any finding it already reports.
2. **False-positive cache** — compute each finding's suppression hash and check
   the cache:

   ```
   python3 ${CLAUDE_PLUGIN_ROOT}/scripts/fp_cache.py check <file> <vector> "<message>"
   ```

   Exit code 0 = suppressed (a human previously marked this pattern as a false
   positive or intentional choice) — silently drop it. The cache lives at
   `.ferret/review-cache.json` in the repo root.
3. **Confidence calibration** — assign per `references/detection-vectors.md`:
   - **HIGH**: you can trace the exact failing input/state through the code;
     structural proof, not suspicion.
   - **MEDIUM**: the defect pattern is present but an unseen invariant elsewhere
     could make it safe.
   - **LOW**: plausible smell that needs human judgment. Report LOW findings
     only in full reviews, never in pre-commit mode.

If nothing survives filtering, say so plainly — a clean report is a valid result.

## Phase 4 — Output

Format every finding per `references/output-schema.md`: severity tier
(CRITICAL / WARNING / SUGGESTION), vector, confidence, clickable
`path/to/file.py:45:12` location, a one-line message, a short explanation of the
failure scenario, and a ready-to-apply unified diff patch whenever a safe fix
exists. Always write the machine-readable JSON findings file to
`.ferret/last-review.json` so `/code-ferret:triage` can pick it up.

## Secret hygiene

Before echoing any code excerpt into a report, PR comment, or external payload,
scrub credentials: run `bash ${CLAUDE_PLUGIN_ROOT}/scripts/scan-secrets.sh` to
locate them, and replace any detected token with `[REDACTED_SECRET]` in your
output. Hardcoded secrets are themselves a CRITICAL/SECURITY finding — report
the location, never the value.

## Light policy

When `FERRET_LIGHT=1` (the CLI's `--light`), trade depth for speed:

- skip the installed-analyzer step entirely
- diff context is already reduced to `-U6` by `collect-context.sh`
- `FERRET_FILE_HISTORY` is absent — do not treat that as "no prior history"
- analyze only the LOGIC and SECURITY vectors

Say in the report that the run was light, so a clean result is not mistaken
for a full-depth pass.

## Oversized scopes

The CLI refuses a scope larger than the `FERRET_MAX_FILES` env var (default
50) before invoking any agent, and suggests up to five narrower re-run
commands. It never splits or retries automatically. `.codeferret.yaml`'s
`reviews.max_files` documents the same intent for the config file but is not
currently read by the CLI (which has zero runtime dependencies and no YAML
parser) — only the env var takes effect today. This is separate from the
>15-file guidance above, which applies to a review you are already
performing: group hunks by directory and cover every one.
