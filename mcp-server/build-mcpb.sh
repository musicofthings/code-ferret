#!/usr/bin/env bash
# Build the CodeFerret MCP Bundle (.mcpb) for one-click install in Claude
# Desktop (and any other MCPB-compatible host).
#
# Vendors the repo's scripts/, skills/, and cli/src into the bundle so the
# server is self-contained (ferret_doctor/ferret_stats load cli/src at
# runtime), installs production dependencies, then packs with the official
# mcpb CLI.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
DIST="$ROOT/dist"

rm -rf "$HERE/vendor"
mkdir -p "$HERE/vendor" "$DIST"
cp -R "$ROOT/scripts" "$HERE/vendor/scripts"
cp -R "$ROOT/skills" "$HERE/vendor/skills"
mkdir -p "$HERE/vendor/cli"
cp -R "$ROOT/cli/src" "$HERE/vendor/cli/src"
rm -rf "$HERE/vendor/scripts/__pycache__"

(cd "$HERE" && npm install --omit=dev --no-audit --no-fund)

npx --yes @anthropic-ai/mcpb pack "$HERE" "$DIST/code-ferret.mcpb"
echo "Built $DIST/code-ferret.mcpb"
