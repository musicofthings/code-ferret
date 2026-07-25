# CodeFerret for OpenAI Codex

Two pieces, both using the same CodeFerret engine (GPT-5.6 does the semantic
analysis; the MCP server provides the deterministic machinery).

## 1. MCP server

First install the server dependencies once (from the repo root):

```bash
cd mcp-server && npm install
```

Then register the server in `~/.codex/config.toml`:

```toml
[mcp_servers.code-ferret]
command = "node"
args = ["/absolute/path/to/code-ferret/mcp-server/server/index.js"]
```

This gives Codex the `ferret_collect_context`, `ferret_run_analyzers`,
`ferret_scan_secrets`, `ferret_fp_cache`, and `ferret_methodology` tools.

## 2. Custom prompts

Copy the prompt files so they appear as slash commands in the Codex TUI:

```bash
mkdir -p ~/.codex/prompts
cp packaging/codex/prompts/*.md ~/.codex/prompts/
```

You get `/ferret-review`, `/ferret-precommit`, and `/ferret-triage`.

## 3. Optional: AGENTS.md guidance

To make CodeFerret behavior persistent in a repository, append the contents of
`packaging/codex/AGENTS-snippet.md` to that repository's `AGENTS.md`.
