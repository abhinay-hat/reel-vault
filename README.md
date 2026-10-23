# Reel Vault

A local-first personal vault for the Instagram reels, posts, DM-shared links, and
articles you save. Everything lives in a single SQLite file on your machine; an
optional local-only sidecar pulls content straight from your Instagram account.

## Requirements

- **Node 24+** — the data layer uses the built-in `node:sqlite` module.
- **Python 3** — only if you use the Instagram private-API sidecar.

## Getting started

```bash
npm install
npm run dev        # http://localhost:3210
```

On macOS you can also double-click `start-reel-vault.command`.

### Optional: Instagram sidecar

A local FastAPI service (`ig-bridge/`) that reads your saved collections and DMs
via Instagram's private mobile API.

```bash
cd ig-bridge
./start-bridge.command   # creates a venv, then runs on http://127.0.0.1:8765
```

> ⚠️ The sidecar uses Instagram's **private** API (`instagrapi`). This violates
> Instagram's Terms of Service and can get your account checkpointed or banned.
> Use it only with your own account, at your own risk. The session never leaves
> `127.0.0.1`.

## Getting content into the vault

1. **Instagram sidecar** — log in and sync from `/connect`.
2. **Instagram data export** — upload your export ZIP at `/ingest`.
3. **Share capture** — the iOS Shortcut / PWA share target / `/bookmarklet`, or
   add a link by hand at `/add`.

Saved items are enriched (summary, category, tags) in the background by Claude
when `ANTHROPIC_API_KEY` is set.

## Configuration (`.env.local`)

| Var | Effect |
|-----|--------|
| `APP_PASSCODE` | Enables a shared-passcode gate (unset = open app) |
| `SHARE_TOKEN` | Enables the `/api/share` capture endpoint |
| `ANTHROPIC_API_KEY` | Enables AI enrichment |
| `REEL_VAULT_DB` | SQLite file path (default `data/reel-vault.db`) |
| `IG_BRIDGE_URL` | Sidecar base URL (default `http://127.0.0.1:8765`) |

## Scripts

```bash
npm run dev      # dev server on :3210
npm run build    # production build
npm start        # production server on :3210
npm test         # vitest run
```
