---
paths:
  - "mcp/**"
---

### MCP server — `mcp/reel-vault-mcp.mjs`

Exposes the vault over stdio so the reels are queryable from any Claude conversation, not just the app's `/chat`. Zero dependencies (built-in `node:sqlite`, hand-rolled JSON-RPC) and **read-only** — a tool that can write is a tool that can silently corrupt years of saved material.

Tools: `search_vault` (ranked by *where* a term hits — title beats a passing transcript mention), `get_item`, `list_entities`, `find_actions`, `list_categories`, `recent_items`, `vault_stats`. Empty results report how many items are still unextracted, so "nothing found" is never mistaken for "nothing saved".

Register: `claude mcp add reel-vault -- node /abs/path/mcp/reel-vault-mcp.mjs`
