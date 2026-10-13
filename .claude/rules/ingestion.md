---
paths:
  - "ig-bridge/**"
  - "src/lib/ig.ts"
  - "src/app/api/ig/**"
  - "src/app/api/ingest/**"
  - "src/app/api/share/**"
  - "src/lib/connectors/**"
  - "src/lib/instagram-export*"
  - "public/manifest.json"
---

### Ingestion — three independent paths, all funnel into `db.ts`

1. **Instagram private-API sidecar** (`ig-bridge/main.py` + `src/lib/ig.ts` + `src/app/api/ig/*`). The API routes are thin proxies to the FastAPI sidecar via `bridge()`. Flow: `POST /api/ig/gather` starts a background job → client polls `GET /api/ig/gather/[id]` → each poll pulls new records and runs `storeGathered()`, which maps sidecar records (`reel`/`post`/`dm_share`/`dm_link`/`dm_text`/`article`) into items/conversations/messages **incrementally** (a per-job cursor stores only the unseen slice). The sidecar uses `instagrapi` (Instagram's **private** API — ToS-violating, can get the account banned; documented at the top of `main.py`) and enforces hard throttles: `MIN_GATHER_INTERVAL_HOURS` (default 20) and a `COOLDOWN_HOURS` (default 6) after any rate-limit/challenge.
2. **Instagram data-export ZIP** (`src/app/api/ingest` → `src/lib/connectors/export-connector.ts`). Unzips with `fflate`, routes files by path regex to the pure parsers in `src/lib/instagram-export.ts` (`parseSavedPosts` / `parseLikedPosts` / `parseInbox`).
3. **Share capture** (`src/app/api/share`). Token-auth (`Bearer SHARE_TOKEN`) endpoint for the iOS Shortcut, plus the PWA Web Share Target (`public/manifest.json`), the desktop bookmarklet (`/bookmarklet`). Extracts the first URL, best-effort OpenGraph fetch, saves with `summary: null` so the enricher picks it up.

The `Connector` interface (`src/lib/connectors/types.ts`) is the seam for adding new import sources.
