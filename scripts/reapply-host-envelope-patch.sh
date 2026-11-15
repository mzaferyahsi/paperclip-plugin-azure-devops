#!/bin/bash
# Paperclip's MCP route sends structuredContent: null for plugin tools (it does not unwrap the plugin envelope), so native-MCP
# agents (claude_local) get "structuredContent expected record, received null". This re-applies the small local fix after a
# Paperclip upgrade. Idempotent. After it reports "patched", run: paperclipai service restart
set -euo pipefail
F=$(readlink -f "$HOME/.paperclip/cli/current")/node_modules/@paperclipai/server/dist/routes/tool-gateway.js
grep -q ado-mcp-envelope-fix "$F" && { echo "already patched: $F"; exit 0; }
cp -p "$F" "$F.orig"
node "$(dirname "$0")/apply-envelope-patch.cjs" "$F"
node --check "$F" && echo "patched: $F (restart needed)"
