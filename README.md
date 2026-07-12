# CodeFerret 🦡

Autonomous code review and bug-hunting plugin for [Claude Code](https://claude.com/claude-code).
Diff-scoped semantic review across five detection vectors — logic, security,
concurrency, performance, and API contracts — with confidence scoring,
linter deduplication, a false-positive suppression cache, interactive triage,
and a pre-commit secret guard.

## Install

```bash
# From a local clone
/plugin marketplace add ~/projects/code-ferret
/plugin install code-ferret@code-ferret-marketplace

# Or once pushed to GitHub
/plugin marketplace add <owner>/code-ferret
/plugin install code-ferret
```

## Commands

| Command | What it does |
|---|---|
| `/code-ferret:review [staged\|head\|<base>]` | Full semantic review of the diff. Writes findings to `.ferret/last-review.json` and prints a report with clickable `file:line:col` locations, severity tiers, confidence ratings, and ready-to-apply patches. |
| `/code-ferret:triage` | Steps through findings one by one: **Accept & apply patch**, **Ignore pattern** (suppresses it in future runs), **Discuss**, or **Skip**. |
| `/code-ferret:precommit` | Fast staged-only check. Reports only CRITICAL + HIGH-confidence blockers and secrets. First line is `FERRET: PASS` or `FERRET: BLOCK`. |

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
```

## GitHub PR automation (optional)

Two options:

1. **GitHub Action** — copy `examples/github-workflow.yml` into
   `.github/workflows/` and set the `ANTHROPIC_API_KEY` secret. Reviews every
   PR and posts inline comments.
2. **Cloudflare Worker webhook proxy** (`worker/`) — a zero-retention
   middleware that verifies the GitHub webhook signature, scrubs secrets from
   payloads before they reach the LLM, fetches the PR diff, runs the review,
   posts inline comments, and reports a Check Run
   (success / neutral / failure). Deploy:

   ```bash
   cd worker
   npm install
   npx wrangler secret put ANTHROPIC_API_KEY
   npx wrangler secret put GITHUB_TOKEN
   npx wrangler secret put GITHUB_WEBHOOK_SECRET
   npx wrangler deploy
   ```

   Then point a repo webhook (event: `pull_request`, content type
   `application/json`, same secret) at the Worker URL. Optionally bind KV/D1
   (see `wrangler.toml`) to sync false-positive suppressions across machines,
   partitioned per repository.

## Privacy guardrails

- Code payloads are regex-scrubbed for credentials (`[REDACTED_SECRET]`)
  before any LLM submission — locally and in the Worker.
- The Worker is pass-through only: no code, diffs, or paths are written to
  KV, D1, or logs. Only 16-char structural hashes of dismissed findings are
  stored, partitioned per repo.

## Layout

```
code-ferret/
├── .claude-plugin/plugin.json      # plugin manifest (+ marketplace.json)
├── commands/                       # /code-ferret:review, :triage, :precommit
├── skills/code-ferret/             # review methodology + vector checklists + schema
├── agents/ferret-reviewer.md       # per-vector subagent for parallel review of big diffs
├── hooks/hooks.json                # PreToolUse git-commit secret guard
├── scripts/                        # collect-context.sh, scan-secrets.sh, fp_cache.py, precommit-guard.sh
├── worker/                         # Cloudflare Worker webhook proxy (optional)
└── examples/                       # GitHub Action workflow, native git hook
```
