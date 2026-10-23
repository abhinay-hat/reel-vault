# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

> Heed `AGENTS.md`: this is a **Vite 8 + React 19 SPA with a Hono API** (migrated off Next.js). Pages live in `src/app/**/page.tsx` as client components that fetch JSON; `src/main.tsx` holds the route table.

## Commands

```bash
npm run dev      # Vite dev server + API on http://localhost:3210 (one process)
npm run build    # dist/ (SPA) + dist-server/index.js (Hono API + static)
npm start        # production server on port 3210 (loads .env.local)
npm test         # vitest run (one-shot, no watch)

npx vitest run src/lib/instagram-export.test.ts   # single test file
npx vitest run -t "parses saved posts"            # single test by name
```

Tests live next to their units (`src/lib/*.test.ts`) and cover the pure parser/prompt helpers (`instagram-export`, `metadata`, `ai`) — not the routes or DB.

Two long-running processes in dev: the Vite app (`start-reel-vault.command`) and the optional Python IG sidecar (`ig-bridge/start-bridge.command`, FastAPI on `127.0.0.1:8765`). Both are double-clickable `.command` scripts.

## Architecture

A personal "vault" for saved Instagram reels, posts, DM-shared links, and articles. Everything runs **local-first** — single SQLite file, optional local-only Instagram sidecar.

### Data layer — `src/lib/db.ts`

The single source of truth. Local SQLite via Node's built-in `node:sqlite` (needs Node 24). Notable: the module is loaded at runtime through `process.getBuiltinModule("node:sqlite")`, **not** a static `import` — keeps `node:sqlite` out of bundling (`ssr.external` in `vite.config.ts`). Keep that pattern if you touch it.

- DB path: `data/reel-vault.db` (override with `REEL_VAULT_DB`). Schema is created on first `db()` call — no migration runner.
- Three tables: `items` (unique by `url`), `conversations` (unique by `thread_key`), `messages` (unique by `conversation_id + external_id`). Writes are idempotent: items/conversations **upsert**, messages **insert-or-ignore**.
- `items.tags` and `participants` are JSON-encoded text columns (see `safeArray`). `origin` is `saved | manual | dm_shared`.
- `created_at` is deliberately caller-suppliable so items sort by their **original** Instagram date, not import time.
- A `supabase/` migration and Supabase deps exist but the data layer is now pure SQLite; treat Supabase as legacy. (`src/app/page.tsx`'s offline message still references Supabase keys — stale copy.)

### Subsystem details (auto-loaded by path from `.claude/rules/`)

- **Ingestion** (IG private-API sidecar — ban risk, hard throttles; export ZIP; share capture; `Connector` seam) → `.claude/rules/ingestion.md`
- **Content extraction** (`pipeline/extract.py`, Apify + ffmpeg/OCR/whisper, `content_status`) → `.claude/rules/content-extraction.md`
- **AI enrichment** (`src/lib/ai.ts`, `/api/enrich-pending`, `src/lib/llm.ts`) → `.claude/rules/ai-enrichment.md`
- **MCP server** (`mcp/reel-vault-mcp.mjs`, read-only by design) → `.claude/rules/mcp-server.md`

### Auth — `server/app.ts` + `src/lib/passcode.ts`

A single shared passcode gates every `/api/*` call via the `rv_auth` cookie (the SPA shell is static; a 401 sends the page to `/login`). **If `APP_PASSCODE` is unset the gate is disabled entirely.** `/login`, `/api/login`, and `/api/share` (bearer-token, not cookie) are exempt.

### Routes & UI

Pages are client components loading JSON with `useJson` (`src/lib/use-json.ts`) from page endpoints in `server/app.ts` (`/api/vault`, `/api/card/:id`, `/api/conversations[/:id]`); the original route handlers stay in `src/app/api/**/route.ts`. Pages: `/` dashboard (search + category filter), `/item/[id]`, `/messages` + `/messages/[id]`, `/connect` (sidecar login/gather UI), `/ingest` (export upload), `/add`, `/bookmarklet`. Components in `src/components/` (`Shell`, `ItemGrid`/`ItemCard`, `MessageThread`, etc.). Tailwind v4 with a custom token palette (`ink`, `surface`, `accent`, …) defined in `globals.css`.

## Environment variables

Full table (`APP_PASSCODE`, `SHARE_TOKEN`, `APIFY_TOKEN`, `LLM_*`, `GROQ_API_KEY`, `REEL_VAULT_*`, `IG_*`): `docs/claude/env-vars.md`.
