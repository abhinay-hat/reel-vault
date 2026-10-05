# Reel Vault v2 — Design Spec

**Date:** 2026-06-02
**Supersedes backend of:** `2026-05-20-reel-vault-design.md` (Convex → Supabase)

## Goal

A personal, single-user web app that ingests a user's Instagram **data export** —
**saved reels/posts** and **direct messages (DMs)** — stores them in **Supabase
Postgres**, enriches them with AI summaries/tags, and makes everything browsable
and searchable. Architected so an official Instagram **Messaging API** live
connector can be added later without refactoring.

## Hard Constraints (from research, 2026)

- **No legal real-time sync of personal-account DMs or saved posts exists.**
  - Saved posts: **no Instagram API at all**, ever. Only via DYI export ZIP (or manual paste/bookmarklet).
  - DM history: only in the DYI export. Official Messaging API returns **only NEW incoming DMs**, business/creator account only, 24h reply window, 200/hr, after Meta App Review (weeks).
- Therefore the **core ingest is the official DYI Data Export ZIP**. The Messaging
  API is a **future additive layer**, not the primary source.
- Sources:
  - [Meta Instagram Messaging API](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api/)
  - [Instagram API overview](https://developers.facebook.com/docs/instagram-platform/overview/)
  - [Export your Instagram data (PIRG)](https://pirg.org/resources/how-to-request-and-download-instagram-data/)

## Architecture

Next.js 16 (App Router) frontend. **Supabase Postgres** backend accessed
server-side through Next route handlers / server actions using the Supabase JS
client. Service-role key is server-only; never shipped to the browser. Passcode
gate (existing middleware) stays.

### Data Model (Supabase Postgres)

```
items                  -- saved reels/posts + manually added links
  id              uuid pk default gen_random_uuid()
  url             text unique not null
  source          text not null check (source in ('instagram','article','other'))
  title           text not null
  author          text
  thumbnail       text
  summary         text
  category        text not null default 'Uncategorized'
  tags            text[] not null default '{}'
  notes           text
  origin          text not null default 'saved'   -- 'saved' | 'manual' | 'dm_shared'
  created_at      timestamptz not null default now()
  search          tsvector  -- generated: title+summary+notes+tags+category

conversations          -- one per DM thread
  id              uuid pk
  thread_key      text unique not null   -- stable id from export folder/participants
  title           text not null          -- participant names
  participants    text[] not null
  last_message_at timestamptz
  created_at      timestamptz default now()

messages               -- individual DMs
  id              uuid pk
  conversation_id uuid references conversations(id) on delete cascade
  external_id     text                    -- dedup key (sender+timestamp)
  sender          text not null
  content         text
  sent_at         timestamptz not null
  shared_url      text                    -- reel/post shared in the DM, if any
  search          tsvector
  unique (conversation_id, external_id)
```

Indexes: GIN on `items.search`, `messages.search`, `items.tags`; btree on
`items.category`, `conversations.last_message_at`, `messages.sent_at`.
Shared reels in DMs (`shared_url`) are auto-promoted into `items` with
`origin='dm_shared'` (deduped by url).

### Ingest — one ZIP drop

`POST /api/ingest` accepts the whole Instagram export `.zip`. Server-side:
1. Unzip in-memory (`fflate` or `unzipper`).
2. Route known files:
   - `**/saved_posts.json` → `parseSavedPosts` → upsert `items` (origin `saved`).
   - `**/messages/inbox/*/message_*.json` → `parseInbox` → upsert `conversations` + `messages`.
   - Shared reels inside messages → upsert `items` (origin `dm_shared`).
3. Idempotent upserts (on-conflict by `url` / `(conversation_id, external_id)`),
   so re-uploading a newer export only adds deltas. Returns counts.

No file-by-file picking. A single drop handles saved + DMs.

### Pluggable Connector interface

```ts
interface Connector {
  name: string;
  ingest(input): Promise<IngestResult>;  // counts of items/messages added
}
```
- `ExportConnector` — implemented now (ZIP).
- `MessagingApiConnector` — stub now; wired to a Meta webhook later for live new DMs. Same `IngestResult` shape → zero downstream refactor.

### AI Enrichment

Keep `src/lib/ai.ts` (Claude Haiku, `buildEnrichPrompt`/`parseEnrichResponse`).
- Saved items: existing enrich (summary/category/tags).
- DM threads: optional thread-level summary + auto-tags (new prompt variant).
Failure returns empty defaults; never blocks ingest. Enrichment runs lazily/in
background after ingest, not inline (export can have thousands of items).

### UI Surfaces (built with impeccable skill)

- **Dashboard** — items grid, category filter, search box (items).
- **Messages** — conversation list → thread view; shared reels render as cards.
- **Unified search** — one query across `items` + `messages` (Postgres FTS).
- **Item detail** — embed/thumbnail, summary, tags, notes, delete.
- **Ingest page** — drag-drop the export ZIP, progress + result counts.
- **Login** — existing passcode gate.

Visual: replace bare Tailwind with a polished, cohesive design system (impeccable).

### Migration from Convex

- Delete `convex/`, `src/components/ConvexClientProvider.tsx`, Convex env vars.
- Replace `useQuery`/`useMutation` call sites with server actions hitting Supabase.
- **Keep** pure libs + tests: `metadata.ts`, `ai.ts`, `instagram-export.ts`.
- **Extend** `instagram-export.ts`: add `parseInbox` (DMs) + shared-media extraction, TDD with fixture JSON.
- Existing API routes (`metadata`, `enrich`, `login`) stay; add `ingest`.

## Error Handling

- ZIP missing expected files → partial ingest, report what was found, never 500 on one bad file.
- Malformed JSON entry → skip that entry, continue, count skips.
- Supabase down → surfaced to user; ingest is resumable (idempotent upserts).
- AI failure → empty defaults, manual edit.

## Testing

- Pure parsers (`parseSavedPosts`, `parseInbox`, shared-media) — Vitest, fixtures.
- Ingest router — unit test with a small synthetic ZIP buffer.
- Build + typecheck gate (`npm run build`).
- Manual (cannot automate headless): real export upload, browser add flow, AI enrich with live key.

## Out of Scope (v2)

- Live Messaging API connector (stub only — needs business account + Meta review).
- Multi-user / sharing.
- Media file hosting (we store thumbnails/urls, not re-host video).
