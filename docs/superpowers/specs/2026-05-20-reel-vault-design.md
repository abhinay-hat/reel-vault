# Reel Vault — Design Spec

**Date:** 2026-05-20
**Status:** Approved
**Location:** `/Users/padidamabhinay/Projects/Experimental/reel-vault`

## Problem

The user saves Instagram reels and articles as reference material — tutorials such as
"how to edit a video", examples of image styles, and similar how-to content. Today these
get shared to a second Instagram account for safekeeping, but there is no structure: the
content cannot be found again when needed. The user wants a personal, searchable knowledge
base — a dashboard — where saved reels and articles are organized, summarized, and
retrievable.

## Goals

- Capture a reel or article with minimal friction, from both phone and desktop.
- Automatically pull title, author, and thumbnail for each saved item.
- Use AI to suggest a summary, category, and tags; let the user confirm or edit.
- Browse everything as a card grid, filter by category/tag, and search across all fields.
- Single-user, private.

## Non-Goals

- No multi-user accounts, sharing, or collaboration.
- No automatic pull of the Instagram "Saved" collection — Instagram provides no API for
  this (see Research Findings). Capture is user-initiated.
- No re-hosting of video files; reels are embedded from their source URL.

## Research Findings (2026)

- **Instagram Graph API** exposes only a Business/Creator account's own published media.
  There is no endpoint for a user's saved posts or collections. Auto-pull is not possible.
- **DM-to-bot webhook (Messaging API)** can receive shared media, but reel shares are
  documented by Meta as delivered to an `UNSUPPORTED` webhook category. Unreliable for the
  exact content the user cares about. Rejected.
- **Web Share Target API (PWA)** lets an installed PWA register as a share target. On a
  phone, tapping Share inside Instagram and choosing the app passes the reel URL to the
  app. No API access, no Terms-of-Service risk. This is the realistic "automatic" path.
- **Instagram oEmbed + OpenGraph** tags provide title, author, and thumbnail for a given
  URL. OpenGraph also works for non-Instagram articles, making capture URL-agnostic.
- **Instagram Data Export ("Download Your Information")** ZIP includes a `saved_posts`
  list of URLs — usable for one-time bulk backfill of historical saves.

## Architecture

**Stack:** Next.js (App Router) + Convex + Claude API. Frontend deployed to Vercel;
Convex on Convex Cloud. Convex provides the database, file storage, and scheduled
functions in one service.

**Hosting rationale:** PWA install and Web Share Target require HTTPS, so the app must be
deployed to a real URL reachable from both phone and desktop.

### Components

1. **Ingest**
   - *PWA Share Target* (phone): `manifest.json` declares `share_target` pointing at
     `/add`. Instagram Share → app → URL captured in one tap.
   - *Desktop bookmarklet*: clicking it on a reel/article page opens `/add?url=...`.
   - *Paste box* on the dashboard: manual fallback, works anywhere.

2. **Metadata fetch** (server route)
   - Given a URL, fetch Instagram oEmbed (for Instagram URLs) and OpenGraph tags
     (any URL) → `title`, `author`, `thumbnail`, raw `caption`/description.

3. **AI enrich** (Claude API)
   - Send caption/title to Claude → `summary`, suggested `category`, suggested `tags[]`.
   - Result shown on a **review screen**; the user confirms or edits before saving
     (AI + manual mix).

4. **Store** — Convex `items` table:
   `url`, `source` (instagram | article | other), `title`, `author`, `thumbnail`,
   `summary`, `category`, `tags` (string[]), `notes`, `createdAt`.

5. **Dashboard**
   - Card grid: thumbnail, title, category badge.
   - Filter by category and tag.
   - Full-text search across `title`, `summary`, `tags`, `notes`.
   - Item detail view: embedded player/preview + editable notes.

6. **Auth** — single-user passcode gate. No account system.

### Data Flow

```
Share / bookmarklet / paste
        │
        ▼
   /add  ──►  metadata fetch (oEmbed + OpenGraph)
        │
        ▼
   AI enrich (Claude: summary + category + tags)
        │
        ▼
   Review screen  ──►  user confirms/edits
        │
        ▼
   Convex items table  ──►  Dashboard (grid, filter, search)
```

### Error Handling

- Metadata fetch failure (private post, dead link, no OpenGraph): fall back to a
  manual-entry form pre-filled with whatever was retrieved; never block the save.
- AI enrich failure or timeout: skip suggestions, let the user fill category/tags
  manually. AI is an assist, not a hard dependency.
- Duplicate URL: detect on add, show the existing item instead of creating a copy.

### Testing

- Unit: metadata parser (oEmbed/OpenGraph extraction), AI-response parser, duplicate
  detection.
- Integration: full add flow with mocked fetch + mocked Claude responses.
- Manual: PWA install + Share Target on a real phone; bookmarklet on desktop.

## Build Phases

- **P1** — Project scaffold, Convex schema, paste-add flow, metadata fetch, dashboard
  grid + filter + search, passcode gate.
- **P2** — AI enrich review screen (Claude integration).
- **P3** — PWA manifest + Web Share Target + desktop bookmarklet.
- **P4** — Bulk import of historical saves from an Instagram Data Export ZIP.

## Open Questions

None. P4 (bulk import) is included.
