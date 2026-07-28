# CodeFerret 🦡

Autonomous code review and bug-hunting plugin, model-agnostic across the
frontier AI stack: [Claude Code](https://claude.com/claude-code) and Claude
Desktop, OpenAI Codex, Gemini CLI, and any other MCP client.
Diff-scoped semantic review across five detection vectors — logic, security,
concurrency, performance, and API contracts — with confidence scoring,
linter deduplication, a false-positive suppression cache, interactive triage,
and a pre-commit secret guard.

**CodeFerret runs entirely on your machine.** There is no CodeFerret service,
account, or API key: the review is performed by a coding agent you already have
installed, and your code never leaves your computer through anything CodeFerret
does. That is the deliberate difference from hosted reviewers like CodeRabbit.
The one setting that can make a network call — dependency auditing — is off by
default and documented below.

## Install

### Claude Code (plugin)

```bash
# From a local clone
/plugin marketplace add ~/projects/code-ferret
/plugin install code-ferret@code-ferret-marketplace

# Or from GitHub
/plugin marketplace add musicofthings/code-ferret
/plugin install code-ferret
```

### Claude Desktop (MCP Bundle)

```bash
bash mcp-server/build-mcpb.sh   # produces dist/code-ferret.mcpb
```

Double-click the bundle (or drag it into Claude Desktop) to install. See
`packaging/claude-desktop/README.md`.

### OpenAI Codex

Register the MCP server in `~/.codex/config.toml` and copy the
`/ferret-review`, `/ferret-precommit`, `/ferret-triage` custom prompts. See
`packaging/codex/README.md`.

### Gemini CLI (extension)

```bash
gemini extensions install https://github.com/musicofthings/code-ferret
cd ~/.gemini/extensions/code-ferret/mcp-server && npm install
```

The repo root is a Gemini CLI extension (`gemini-extension.json`): it wires up
the MCP server, `GEMINI.md` context, and `/ferret:review`, `/ferret:precommit`,
`/ferret:triage` commands.

### Any other MCP client (Cursor, Grok desktop, ...)

Run `npm install` in `mcp-server/`, then point the client at
`node mcp-server/server/index.js` (stdio). The host's model does the semantic
analysis, so CodeFerret works with whichever frontier model the client runs.

## Model compatibility

CodeFerret never calls a model API itself. The semantic analysis is done by
whatever model your host application already runs — Claude Code, Claude
Desktop, Codex, Gemini CLI, or any other MCP client — so it is model-agnostic
by construction, with no provider registry, no key to configure, and no model
for CodeFerret to keep up to date.

The standalone CLI works the same way: it shells out to an installed `claude`,
`codex`, or `gemini` and reads back the findings file. See [CLI](#cli).

## Commands

| Command | What it does |
|---|---|
| `/code-ferret:review [staged\|head\|<base>]` | Full semantic review of the diff. Writes findings to `.ferret/last-review.json` and prints a report with clickable `file:line:col` locations, severity tiers, confidence ratings, and ready-to-apply patches. |
| `/code-ferret:triage` | Steps through findings one by one: **Accept & apply patch**, **Ignore pattern** (suppresses it in future runs), **Discuss**, or **Skip**. |
| `/code-ferret:precommit` | Fast staged-only check. Reports only CRITICAL + HIGH-confidence blockers and secrets. First line is `FERRET: PASS` or `FERRET: BLOCK`. |

## CLI

CodeFerret also ships a standalone CLI that runs reviews from any terminal by
delegating to a coding agent you already have installed (`claude`, `codex`, or
`gemini`) — no API key and no CodeFerret account.

```bash
cd cli && npm link      # or, from the repo root: npm install -g ./cli
ferret doctor           # verify the setup first
ferret                  # review committed + staged + unstaged changes
```

| Command | What it does |
|---|---|
| `ferret [review]` | Review the current diff; plain-text report |
| `ferret review --agent` | Structured JSONL for coding agents and automation |
| `ferret review --light` | Fast policy: no analyzers, `-U10` context, LOGIC + SECURITY only |
| `ferret review findings` | Replay the last review without re-analyzing |
| `ferret review --show-prompts` | Print the prompts from the last review |
| `ferret doctor` | Verify setup and connectivity; exit 1 on failure |
| `ferret stats [--rebuild]` | Review statistics from `.ferret/history.jsonl` |

Scope flags: `--committed`, `--uncommitted`, `--include-untracked`,
`--base <branch>`, `--base-commit <sha>`, `--dir <path>`, `-c/--config <file>`.
Contradictory combinations are rejected before a review starts, as is a base
ref that does not resolve — a review that cannot run always exits non-zero,
never "no changes found".

### Agent output (`--agent`)

One JSON object per line on stdout, and nothing else — anything a human would
read goes to stderr.

| `type` | When |
|---|---|
| `review_context` | Once, first: target, branch, base ref, file count, agent, light |
| `status` | Phase change: `collecting_context`, `reviewing`, or `review_skipped` |
| `heartbeat` | Every 15s while the agent is running |
| `finding` | One per finding; severity on the wire is `critical`/`major`/`minor` |
| `prompts` | `--show-prompts` only: the saved prompts from the last review |
| `complete` | Once, last, on success — including the empty-diff case |
| `error` | Once, last, on any failure |

Every failure path emits an `error` event, including ones that occur before a
review starts (bad flags, unresolvable base ref, no agent, a blocked lock), so
a consumer never has to distinguish "failed" from "produced nothing".

### Concurrent reviews

Reviews are serialized per repository through a `.ferret/review.lock`. A second
`ferret review` against the same repo fails immediately, naming the process
that holds the lock, rather than queueing or letting two agents overwrite each
other's results. A lock left behind by a killed process is reclaimed
automatically — either its process is gone, or it has aged out.

The MCP review prompt takes the same lock through the `ferret_review_lock`
tool, so a prompt-driven review and a terminal `ferret review` cannot run
against one repository at once. That path holds a **30-minute lease** rather
than a process-lifetime lock: the MCP server stays alive between tool calls, so
its process being up says nothing about whether a review is still going, and
only an expiry can free one that was abandoned mid-conversation. Use
`ferret_review_lock` with `status` to see the holder, or `release` with `force`
to clear an abandoned lock without waiting out the lease.

Because the agent writes `.ferret/last-review.json` with its own file tools
rather than through the server, this lock is **cooperative** — it is honored by
the shipped review prompt, not enforced against an agent that ignores it.

Every `ferret review` spawns a real agent session against your existing
subscription. Use `--light` for the cheap path, and keep the git pre-commit
hook on the pure-bash secret scan rather than a full review.

## What gets reviewed

Only the diff plus its surrounding lexical scope (±50 lines), never the whole
repo. Standard `.gitignore` rules apply automatically; add a `.ferretignore`
(gitignore syntax) at the repo root to also skip generated files, schemas,
minified assets, etc.

Detection vectors:

- **LOGIC** — off-by-one, boundary conditions, null/undefined flow, unhandled promises, resource leaks, infinite loops
- **SECURITY** — hardcoded secrets, SQL injection, XSS, unsafe deserialization, OWASP Top 10
- **CONCURRENCY** — races, deadlocks, non-atomic read-modify-write, unsynchronized shared state
- **PERFORMANCE** — O(N²) on unbounded data, N+1 queries, redundant allocations
- **API** — breaking public contract changes, type-safety violations, SDK misuse

Style and lint issues are explicitly out of scope — findings matching an
existing linter rule are deduplicated away.

Before semantic analysis, full reviews run known analyzers that are already
installed: ESLint, Ruff, ShellCheck, TypeScript, Semgrep with a checked-in
configuration, and the CodeFerret secret scanner. Tools are never installed
automatically or invoked through arbitrary package scripts. Normalized,
secret-scrubbed results are saved to `.ferret/tool-results.json`. Analyzers run
in the current environment and may load repository-owned configuration or
plugins, so run them only in a checkout you trust.

Dependency auditing (`npm audit`, `pip-audit`) is **off by default**: it is the
only analyzer group that contacts the network, sending your dependency tree to
the npm registry or the advisory API. Your source is never sent, but the call
happens, so enabling it is a deliberate choice — set `tools.dependencies: true`
in `.codeferret.yaml`. Everything else runs offline.

## Configuration

Copy `.codeferret.example.yaml` to `.codeferret.yaml` to configure review
behavior. Supported controls include:

- `reviews.profile`: `chill`, `balanced`, or `assertive`
- `reviews.minimum_severity`: `critical`, `warning`, or `suggestion`
- `reviews.ignore`: repository-relative glob patterns
- `reviews.path_instructions`: focused review policy for matching paths
- `guidelines`: automatic discovery of `AGENTS.md`, `CLAUDE.md`,
  `.cursorrules`, or additional repository policy files
- `reports`: PR summary, walkthrough, risk assessment, and linked-issue
  validation controls
- `tools`: installed linter, type-checker, security, dependency, and CI-context
  controls with bounded execution time

`/code-ferret:review` runs use the working tree configuration and root-level
guideline context from `collect-context.sh`.

## Noise control

- Every finding carries a **confidence** rating (HIGH/MEDIUM/LOW) based on
  structural proof, independent of **severity** (CRITICAL/WARNING/SUGGESTION).
- Choosing **Ignore pattern** during triage records a structural hash in
  `.ferret/review-cache.json`; matching findings are silently suppressed in
  future reviews. Manage the cache with:

  ```bash
  python3 scripts/fp_cache.py list
  python3 scripts/fp_cache.py add <file> <vector> "<message>" "<reason>"
  ```

  Commit `.ferret/review-cache.json` to share suppressions with your team.

## Pre-commit guard (hook)

The plugin ships a `PreToolUse` hook: whenever Claude Code runs `git commit`,
staged changes are regex-scanned for credentials (GitHub/AWS/Anthropic/Slack
tokens, private keys, generic high-entropy assignments) and the commit is
blocked if any are found. It is fast (pure bash/grep, no LLM call).

For commits made outside Claude Code, install the native git hook:

```bash
cp examples/git-pre-commit-hook .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit
git config codeferret.root "$(pwd)"
```

If the target repository is not the CodeFerret checkout, set
`codeferret.root` to CodeFerret's absolute installation path instead.

## GitHub PR automation (optional, and not local)

`examples/github-workflow.yml` runs CodeFerret's methodology on every pull
request via `claude-code-action`. Copy it into `.github/workflows/` and set the
`ANTHROPIC_API_KEY` repository secret.

This is the one path in this repository that is **not** local: it runs on
GitHub's runners and sends your diff to a model API under your own API key and
account. Nothing else in CodeFerret does that, and nothing requires you to use
it. Skip this section entirely to keep every review on your own machine.

## Privacy guardrails

- Reviews run on your machine, through a coding agent you already installed.
  There is no CodeFerret service or account, and no telemetry.
- Code payloads are regex-scrubbed for credentials (`[REDACTED_SECRET]`) before
  reaching the model.
- Secret *locations* are reported, never secret values.
- Nothing CodeFerret runs contacts the network, with one opt-in exception:
  dependency auditing (`tools.dependencies`, off by default) calls the npm
  registry / advisory API. Your source is never transmitted.
- `.ferret/` state stays in your working tree; only the shareable
  false-positive cache (`review-cache.json`) is intended to be committed.

## Tests

```bash
# Shell collectors, secret scanner, commit guards, and the analyzer runner
bash tests/run.sh

# CLI unit tests
cd cli && npm test
```

## Layout

```
code-ferret/
├── .claude-plugin/plugin.json      # Claude Code plugin manifest (+ marketplace.json)
├── gemini-extension.json           # Gemini CLI extension manifest (+ GEMINI.md)
├── commands/                       # /code-ferret:* (Claude Code .md) + ferret/*.toml (Gemini CLI)
├── skills/code-ferret/             # review methodology + vector checklists + schema
├── agents/ferret-reviewer.md       # per-vector subagent for parallel review of big diffs
├── hooks/hooks.json                # PreToolUse git-commit secret guard
├── scripts/                        # collectors, analyzers, fp cache
├── cli/                            # standalone `ferret` CLI (delegates to your agent)
├── mcp-server/                     # MCP server + MCPB bundle build (Claude Desktop et al.)
├── packaging/                      # Codex prompts/config, Claude Desktop install guide
└── examples/                       # optional GitHub Action workflow, native git hook
```
