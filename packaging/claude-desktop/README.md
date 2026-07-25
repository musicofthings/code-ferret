# CodeFerret for Claude Desktop

CodeFerret ships as an MCP Bundle (`.mcpb`) for one-click installation.

## Build the bundle

```bash
bash mcp-server/build-mcpb.sh
```

This vendors `scripts/` and `skills/` into the server, installs production
dependencies, and packs `dist/code-ferret.mcpb` with the official
`@anthropic-ai/mcpb` CLI.

## Install

Double-click `dist/code-ferret.mcpb`, drag it into the Claude Desktop window,
or use Settings → Extensions → Advanced settings → Install Extension…

Requires Node.js ≥ 18 on the machine (the server runs `bash`, `git`, and
`python3` for its collectors, so it targets macOS/Linux or Windows with WSL
or Git Bash).

## Use

- The `review`, `precommit`, and `triage` prompts appear in the prompt picker.
- Tools: `ferret_collect_context`, `ferret_run_analyzers`,
  `ferret_scan_secrets`, `ferret_fp_cache`, `ferret_methodology`.
- Claude Desktop's model does the semantic analysis; no extra API key is
  needed beyond your Claude subscription.

## Manual configuration (alternative)

Without the bundle, point Claude Desktop straight at a checkout by adding to
`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "code-ferret": {
      "command": "node",
      "args": ["/absolute/path/to/code-ferret/mcp-server/server/index.js"]
    }
  }
}
```

(Run `npm install` in `mcp-server/` first.)
