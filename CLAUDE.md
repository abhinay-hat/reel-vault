# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

> Heed `AGENTS.md`: this is Next.js **16.2.6** (App Router, React 19, Turbopack). APIs and conventions differ from older Next.js — consult `node_modules/next/dist/docs/` before writing framework code.

## Commands

```bash
npm run dev      # Next.js dev server on http://localhost:3210 (NOT 3000)
npm run build    # production build
npm start        # production server on port 3210
npm test         # vitest run (one-shot, no watch)

npx vitest run src/lib/instagram-export.test.ts   # single test file
npx vitest run -t "parses saved posts"            # single test by name
```

Tests live next to their units (`src/lib/*.test.ts`) and cover the pure parser/prompt helpers (`instagram-export`, `metadata`, `ai`) — not the routes or DB.

Two long-running processes in dev: the Next app (`start-reel-vault.command`) and the optional Python IG sidecar (`ig-bridge/start-bridge.command`, FastAPI on `127.0.0.1:8765`). Both are double-clickable `.command` scripts.

## Architecture

A personal "vault" for saved Instagram reels, posts, DM-shared links, and articles. Everything runs **local-first** — single SQLite file, optional local-only Instagram sidecar.

### Data layer — `src/lib/db.ts`

The single source of truth. Local SQLite via Node's built-in `node:sqlite` (needs Node 24). Notable: the module is loaded at runtime through `process.getBuiltinModule("node:sqlite")`, **not** a static `import` — Turbopack's externalization shim breaks the static form in ESM server chunks. Keep that pattern if you touch it.

- DB path: `data/reel-vault.db` (override with `REEL_VAULT_DB`). Schema is created on first `db()` call — no migration runner.
- Three tables: `items` (unique by `url`), `conversations` (unique by `thread_key`), `messages` (unique by `conversation_id + external_id`). Writes are idempotent: items/conversations **upsert**, messages **insert-or-ignore**.
- `items.tags` and `participants` are JSON-encoded text columns (see `safeArray`). `origin` is `saved | manual | dm_shared`.
- `created_at` is deliberately caller-suppliable so items sort by their **original** Instagram date, not import time.
- A `supabase/` migration and Supabase deps exist but the data layer is now pure SQLite; treat Supabase as legacy. (`src/app/page.tsx`'s offline message still references Supabase keys — stale copy.)

### Ingestion — three independent paths, all funnel into `db.ts`

1. **Instagram private-API sidecar** (`ig-bridge/main.py` + `src/lib/ig.ts` + `src/app/api/ig/*`). The Next routes are thin proxies to the FastAPI sidecar via `bridge()`. Flow: `POST /api/ig/gather` starts a background job → client polls `GET /api/ig/gather/[id]` → each poll pulls new records and runs `storeGathered()`, which maps sidecar records (`reel`/`post`/`dm_share`/`dm_link`/`dm_text`/`article`) into items/conversations/messages **incrementally** (a per-job cursor stores only the unseen slice). The sidecar uses `instagrapi` (Instagram's **private** API — ToS-violating, can get the account banned; documented at the top of `main.py`) and enforces hard throttles: `MIN_GATHER_INTERVAL_HOURS` (default 20) and a `COOLDOWN_HOURS` (default 6) after any rate-limit/challenge.
2. **Instagram data-export ZIP** (`src/app/api/ingest` → `src/lib/connectors/export-connector.ts`). Unzips with `fflate`, routes files by path regex to the pure parsers in `src/lib/instagram-export.ts` (`parseSavedPosts` / `parseLikedPosts` / `parseInbox`).
3. **Share capture** (`src/app/api/share`). Token-auth (`Bearer SHARE_TOKEN`) endpoint for the iOS Shortcut, plus the PWA Web Share Target (`public/manifest.json`), the desktop bookmarklet (`/bookmarklet`), and the manual-add server action (`src/app/actions.ts`). Extracts the first URL, best-effort OpenGraph fetch, saves with `summary: null` so the enricher picks it up.

The `Connector` interface (`src/lib/connectors/types.ts`) is the seam for adding new import sources.

### Content extraction — `pipeline/extract.py` + `pipeline/reelvault/`

A DM-shared reel arrives as a bare URL: Instagram's share payload has no caption, so those items land titled `Shared by <user id>` with nothing inside. Until this pipeline runs, the vault holds pointers, not knowledge.

Default path (₹0): Apify Free actor `apify~instagram-scraper` fetches caption + media URL; then local ffmpeg keyframes, Apple Vision + Tesseract (hin/tel), and mlx-whisper fill `transcript` / `ocr_text`. `content_status` tracks pipeline position (`pending` → `fetched` → `transcribed` → `enriched`). Sidecar fetch is opt-in only (`--fetcher sidecar`). See `docs/KNOWLEDGE-BASE.md`. One-time install: `./pipeline/setup.sh`.

### AI enrichment — `src/lib/ai.ts` + `src/app/api/enrich*`

Items are saved with `summary: null` and enriched later. `ai.ts` holds the pure prompt builders and JSON parsers (tested, dependency-free — it also owns `EntityKind`, which `db.ts` imports as a type). `buildKnowledgePrompt`/`parseKnowledgeResponse` turn extracted text into summary, category, tags, `entities` (named films, portals, models, universities — the field that makes "list every anime I saved" answerable) and `actions`. Parsing degrades field by field: a malformed entity list must not cost the summary, since enrichment runs unattended.

`/api/enrich-pending` pulls up to 20 items via `listItemsNeedingEnrichment` and reads only locally-extracted text. It deliberately does **not** call `convertToMarkdown(url)` — for a reel that fetches an Instagram HTML shell with no caption in it, which is why the old version summarised nothing for all 386 DM-shared reels.

The LLM seam is `src/lib/llm.ts`: default `LLM_PROVIDER=local` → OpenAI-compatible `mlx_lm.server` (`pipeline/start-llm.command`, Qwen3-4B). Optional `groq` uses allow-listed free models only. Batch helper: `scripts/enrich-all.sh`.

### MCP server — `mcp/reel-vault-mcp.mjs`

Exposes the vault over stdio so the reels are queryable from any Claude conversation, not just the app's `/chat`. Zero dependencies (built-in `node:sqlite`, hand-rolled JSON-RPC) and **read-only** — a tool that can write is a tool that can silently corrupt years of saved material.

Tools: `search_vault` (ranked by *where* a term hits — title beats a passing transcript mention), `get_item`, `list_entities`, `find_actions`, `list_categories`, `recent_items`, `vault_stats`. Empty results report how many items are still unextracted, so "nothing found" is never mistaken for "nothing saved".

Register: `claude mcp add reel-vault -- node /abs/path/mcp/reel-vault-mcp.mjs`

### Auth — `src/middleware.ts` + `src/lib/passcode.ts`

A single shared passcode gates the whole app via the `rv_auth` cookie. **If `APP_PASSCODE` is unset the gate is disabled entirely.** `/login`, `/api/login`, and `/api/share` (bearer-token, not cookie) are exempt.

### Routes & UI

Server Components fetch directly from `db.ts`; mutations go through Server Actions (`src/app/actions.ts`) or route handlers. Pages: `/` dashboard (search + category filter), `/item/[id]`, `/messages` + `/messages/[id]`, `/connect` (sidecar login/gather UI), `/ingest` (export upload), `/add`, `/bookmarklet`. Components in `src/components/` (`Shell`, `ItemGrid`/`ItemCard`, `MessageThread`, etc.). Tailwind v4 with a custom token palette (`ink`, `surface`, `accent`, …) defined in `globals.css`.

## Environment variables

| Var | Effect |
|-----|--------|
| `APP_PASSCODE` | Enables the passcode gate (unset = open app) |
| `SHARE_TOKEN` | Enables `/api/share` (unset = 503) |
| `APIFY_TOKEN` | Enables Apify Free fetcher for `pipeline/extract.py --run` |
| `LLM_PROVIDER` | `local` (default) or `groq` |
| `LLM_BASE_URL` | OpenAI-compatible base (default local `:8090/v1` or Groq) |
| `LLM_MODEL` | Must be on the allow-list in `src/lib/llm.ts` / guardrails |
| `GROQ_API_KEY` | Required only when `LLM_PROVIDER=groq` |
| `KEEP_MEDIA` | Keep downloaded mp4s under `data/media/` |
| `REEL_VAULT_WHISPER_MODEL` | Whisper weights (default `mlx-community/whisper-small-mlx`) |
| `REEL_VAULT_DB` | SQLite file path override |
| `REEL_VAULT_MEDIA` | Media directory override |
| `IG_BRIDGE_URL` | Sidecar base URL (default `http://127.0.0.1:8765`) |
| `IG_MEDIA_MIN_INTERVAL_SECONDS` | Sidecar-only pacing (default 25) — ban guard |
| `IG_SESSION_FILE`, `IG_MIN_GATHER_INTERVAL_HOURS`, `IG_COOLDOWN_HOURS` | Sidecar-side (Python) config |
