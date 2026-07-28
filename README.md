# CodeFerret 🦡

Autonomous code review and bug-hunting plugin, model-agnostic across the
frontier AI stack: [Claude Code](https://claude.com/claude-code) and Claude
Desktop, OpenAI Codex, Gemini CLI, and any other MCP client — with a webhook
Worker that can run reviews on Claude, GPT/Codex, Gemini, or Grok APIs.
Diff-scoped semantic review across five detection vectors — logic, security,
concurrency, performance, and API contracts — with confidence scoring,
linter deduplication, a false-positive suppression cache, interactive triage,
and a pre-commit secret guard.

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

The host application's model performs the review in plugin/MCP mode, so local
use is automatically model-agnostic. The Cloudflare Worker (webhook reviews)
calls a provider API directly and supports:

| Provider | API | Default model | Key |
|---|---|---|---|
| Anthropic (Claude) | Messages | `claude-sonnet-5` | `ANTHROPIC_API_KEY` |
| OpenAI (GPT / Codex) | Responses | `gpt-5.6-terra` | `OPENAI_API_KEY` |
| Google (Gemini) | generateContent | `gemini-3.6-flash` | `GEMINI_API_KEY` / `GOOGLE_API_KEY` |
| xAI (Grok) | Chat Completions | `grok-4.5` | `XAI_API_KEY` |

`models.json` at the repo root is the single source of truth for providers,
model IDs, endpoints, and API-docs URLs. The Worker picks the first provider
with a configured key (override with the `CODEFERRET_PROVIDER` /
`CODEFERRET_MODEL` vars in `worker/wrangler.toml`).

### Automatic weekly model & API-docs updates

`.github/workflows/model-check.yml` runs `scripts/check_models.py` every
Monday: it queries each provider's live model-listing API, records
additions/removals, promotes a fallback if a default model is retired, and
hashes provider API docs to flag breaking-change reviews. Any registry change
is opened as a pull request — merging it is the plugin's auto-update path.
Configure the optional `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`GEMINI_API_KEY`, and `XAI_API_KEY` repository secrets to enable listing for
each provider (docs are checked without keys).

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

Before semantic analysis, full local reviews run known analyzers that are
already installed: ESLint, Ruff, ShellCheck, TypeScript, Semgrep with a checked-in
configuration, the CodeFerret secret scanner, npm audit, and pip-audit. Tools are
never installed automatically or invoked through arbitrary package scripts.
Normalized, secret-scrubbed results are saved to `.ferret/tool-results.json`.
Local analyzers run in the current environment and may load repository-owned
configuration or plugins, so run them only in a checkout you trust. The
Cloudflare Worker never executes repository code; it only reads completed
GitHub Check output and annotations.

## Configuration

Copy `.codeferret.example.yaml` to `.codeferret.yaml` to configure review
behavior. Supported controls include:

- `reviews.profile`: `chill`, `balanced`, or `assertive`
- `reviews.minimum_severity`: `critical`, `warning`, or `suggestion`
- `reviews.auto_review`: enable webhook reviews and opt drafts in or out
- `reviews.ignore`: repository-relative glob patterns
- `reviews.path_instructions`: focused review policy for matching paths
- `guidelines`: automatic discovery of `AGENTS.md`, `CLAUDE.md`,
  `.cursorrules`, or additional repository policy files
- `reports`: PR summary, walkthrough, risk assessment, and linked-issue
  validation controls
- `tools`: installed linter, type-checker, security, dependency, and CI-context
  controls with bounded execution time

An unmet linked requirement makes the CodeFerret Check Run fail; partial or
unknown coverage produces a neutral conclusion for human review.

The Worker loads configuration and guidelines from the PR's trusted base commit,
so a pull request cannot weaken its own review policy. Configuration changes
take effect after they merge. Local `/code-ferret:review` runs use the working
tree configuration and root-level guideline context from `collect-context.sh`.

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

## GitHub PR automation (optional)

Two options:

1. **GitHub Action** — copy `examples/github-workflow.yml` into
   `.github/workflows/` and set the `ANTHROPIC_API_KEY` secret. Reviews every
   PR and posts inline comments.
2. **Cloudflare Worker webhook proxy** (`worker/`) — a zero-retention
   middleware that verifies the GitHub webhook signature, scrubs secrets from
   payloads before they reach the LLM, fetches the PR diff, runs the review,
   posts inline comments, updates a marked CodeFerret summary in the PR
   description, maintains a structured walkthrough comment, validates linked
   issue requirements, and reports a Check Run (success / neutral / failure).
   Deploy:

   ```bash
   cd worker
   npm install
   npx wrangler secret put ANTHROPIC_API_KEY   # or OPENAI_API_KEY / GEMINI_API_KEY / XAI_API_KEY
   npx wrangler secret put GITHUB_TOKEN
   npx wrangler secret put GITHUB_WEBHOOK_SECRET
   npx wrangler deploy
   ```

   The Worker reviews with whichever provider key you configure (see **Model
   compatibility** above); pin a specific provider/model with the
   `CODEFERRET_PROVIDER` and `CODEFERRET_MODEL` vars in `wrangler.toml`.

   Then point a repo webhook (events: `pull_request` and `check_run`, content
   type `application/json`, same secret) at the Worker URL. Failed external
   checks trigger one idempotent CI-context review; CodeFerret's own Check Run
   is ignored to prevent loops. Optionally bind KV/D1
   (see `wrangler.toml`). KV tracks the last reviewed PR commit and active
   finding fingerprints plus the walkthrough comment ID so synchronize events
   become incremental and update existing report artifacts instead of posting
   duplicates. D1 provides repository-partitioned suppression lookups.

## Privacy guardrails

- Code payloads are regex-scrubbed for credentials (`[REDACTED_SECRET]`)
  before any LLM submission — locally and in the Worker.
- The Worker is pass-through only: no code, diffs, or paths are written to
  KV, D1, or logs. KV stores reviewed commit SHAs, 16-character active finding
  fingerprints, the numeric walkthrough-comment ID, and names of currently
  failing CI checks; D1 stores 16-character suppression hashes, partitioned per
  repository.

## Tests

```bash
# Shell collectors, secret scanner, commit guards, analyzer runner,
# and the model-registry checker
bash tests/run.sh

# Cloudflare Worker unit tests (incl. multi-provider layer) and type checking
cd worker
npm install
npm test
npm run typecheck
```

## Layout

```
code-ferret/
├── .claude-plugin/plugin.json      # Claude Code plugin manifest (+ marketplace.json)
├── gemini-extension.json           # Gemini CLI extension manifest (+ GEMINI.md)
├── models.json                     # model/provider registry (single source of truth)
├── commands/                       # /code-ferret:* (Claude Code .md) + ferret/*.toml (Gemini CLI)
├── skills/code-ferret/             # review methodology + vector checklists + schema
├── agents/ferret-reviewer.md       # per-vector subagent for parallel review of big diffs
├── hooks/hooks.json                # PreToolUse git-commit secret guard
├── scripts/                        # collectors, analyzers, fp cache, check_models.py
├── mcp-server/                     # MCP server + MCPB bundle build (Claude Desktop et al.)
├── packaging/                      # Codex prompts/config, Claude Desktop install guide
├── worker/                         # Cloudflare Worker webhook proxy (multi-provider)
├── .github/workflows/              # weekly model-registry & API-docs checker
└── examples/                       # GitHub Action workflow, native git hook
```
