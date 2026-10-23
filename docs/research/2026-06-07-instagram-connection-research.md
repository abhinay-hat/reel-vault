# Reel Vault — How to Connect Instagram (Deep Research)

**Date:** 2026-06-07
**Question:** How should Reel Vault connect to a personal Instagram account so it can read the
owner's saved reels/posts, liked content, and reels shared in DMs, then auto-summarize and
categorize everything (anime, movies, AI news, AI tools, etc.) for calm retrieval?

This report compares every viable connection path with current (mid-2026) status, lays out the
AI summarization/categorization pipeline, and gives a concrete recommended architecture that
builds on what you already have (`ig-bridge/` instagrapi sidecar + Next.js 16 + Supabase v2).

> Confidence tags: **[H]** high (primary/official source), **[M]** medium (corroborated
> secondary sources), **[L]** low (single/uncertain source). Sources are linked at the end of
> each section and collected at the bottom.

---

## TL;DR — the one-paragraph answer

There is **no official API that can read your saved posts or your liked posts** — not in any
form, period. Those only come out of Instagram's **"Download Your Information" (DYI) export**,
which is manual (no API), email-notified, and re-requestable about every 4 days. **DM-shared
reels, by contrast, ARE officially reachable**: convert the account to a free *Professional*
account, build a single-user app with **Standard Access (no App Review, no Facebook Page)**, and
use the **Self Messaging** + **Conversations API** / messaging webhooks to capture `ig_reel`
attachments. The fastest *capture* path for "I just found a good reel, save it" is a **share
target**: an Android PWA `share_target` and an **iOS Shortcut that POSTs the URL** to Reel Vault.
The **instagrapi sidecar you already built is the only thing that can read your full Saved
collection automatically**, but it uses Instagram's private mobile API, violates ToS, and carries
a real (if low-for-personal-use) account-ban risk — keep it as an *optional, hardened, opt-in*
backfill, not the backbone. For the AI side, **download the reel with yt-dlp + your own cookies,
transcribe with local whisper.cpp (free) or Groq Whisper (~$0.0007/reel), and do
summary+category+tags in one structured call to Gemini Flash-Lite (~$0.006/reel, often free
tier)**; store an embedding in **Supabase pgvector** for hybrid keyword+semantic search. Net AI
cost for a personal hoard is effectively a rounding error; the only fragile/risky stage is
getting the bytes out of Instagram.

**Recommended combination:** Share-sheet (instant capture) **+** periodic DYI export (complete
backfill of saved/liked/DMs) **+** Professional-account Self-Messaging (official live DM capture)
**+** hardened opt-in instagrapi (full Saved sync) → unified into your existing Supabase
`items`/`conversations`/`messages` schema → AI enrichment worker → hybrid search.

---

## 1. Official Meta / Instagram APIs

The legacy **Instagram Basic Display API** — the last API that worked with *personal* accounts —
was **fully shut down on December 4, 2024**. [H] Everything official today is "Instagram
Platform," which comes in two flavors and **requires an Instagram *Professional* (Business or
Creator) account** (a free switch in the app):

- **Instagram API with Instagram Login** — host `graph.instagram.com`, **no Facebook Page
  required**. [H]
- **Instagram API with Facebook Login** (Messenger Platform) — host `graph.facebook.com`,
  **requires a linked Facebook Page**. [H]

### What you can and cannot read

| Content you want | Official API? | Notes |
|---|---|---|
| **Saved posts / saved collections** | **No** | No `saved` edge exists on the IG User node in any API version (verified across the full 2018–2026 changelog). The only "saved" field is `saved_count` on *your own published media* — how many people saved *your* post, not what you saved. [H] |
| **Liked posts** | **No** | The Apr 2026 "Like Media" API is **write-only** (`POST/DELETE /<IG_USER_ID>/likes`). No read endpoint. The old `/users/self/media/liked` died with Basic Display. [H] |
| **DM threads + reels shared in DMs** | **Yes** | Conversations API + messaging webhooks. See below. [H] |
| Your own published media, comments, mentions, insights, stories | Yes | Not relevant to a saved-archive use case. [H] |

So: **for saved and liked, the official surface is a dead end.** This is the single most important
finding and it forces the architecture.

### DMs — the one official path that helps you

DM access requires a Professional account + `instagram_business_basic` +
`instagram_business_manage_messages`. With **Instagram Login you do NOT need a Facebook Page**. [H]

- **Reels shared into DMs surface as attachments** with documented types including `ig_reel`,
  `reel`, `ig_post`, `story`, each carrying a `payload.url` (a CDN media URL). The legacy `share`
  type is deprecated after Feb 2026 in favor of `ig_post`. [H]
- **Conversations API** lets you list threads and messages: `GET /me/conversations?platform=instagram`
  → `GET /<CONVERSATION_ID>?fields=messages` → `GET /<MESSAGE_ID>?fields=...`. [H]
- **Two hard limits, verified verbatim in the docs:** (1) *"you can only get details about the 20
  most recent messages in the conversation"* — older messages return a deleted error; (2) *"Only
  the image or video URL for a share will be included"* (no caption/author guaranteed), and
  Requests-folder threads inactive >30 days aren't returned. [H]
- **No App Review needed for your own account.** Docs say verbatim: *"Standard Access if your app
  serves Instagram professional accounts you own or manage and have added to your app in the App
  Dashboard."* App Review + Business Verification are only for serving accounts you don't own. [H]

### The 2025 sleeper feature: Self Messaging

Added Nov 2025 and **purpose-built for exactly your "send a reel to myself and have my app catch
it" idea.** [H] When the Professional account DMs *itself* in the Instagram app, an **echo
webhook fires with `"is_self": true`** containing the message (and attachments). It works with
**Standard Access**, **Instagram Login (no Facebook Page)**, permissions
`instagram_business_basic` + `instagram_business_manage_messages`, and the 24-hour response
window does not apply. In practice: you create a "Saved by me" self-thread, share any reel to
yourself, and Reel Vault receives it via webhook in real time — fully official.

**Caveat:** webhooks need a public HTTPS endpoint, and the share attachment gives you the media
URL only, so you still enrich (title/caption) downstream.

Sources: [IG Platform overview](https://developers.facebook.com/docs/instagram-platform/overview) ·
[Changelog](https://developers.facebook.com/docs/instagram-platform/changelog) ·
[Conversations API](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/conversations-api) ·
[Self Messaging](https://developers.facebook.com/docs/instagram-platform/self-messaging) ·
[Webhook examples](https://developers.facebook.com/docs/instagram-platform/webhooks/examples) ·
[Basic Display shutdown](https://developers.facebook.com/blog/post/2024/09/04/update-on-instagram-basic-display-api/)

---

## 2. Official data export (Download Your Information)

This is the **only official source of your saved and liked history**, and you already parse it in
`src/lib/instagram-export.ts`. Current state:

- **Path:** Accounts Center → "Your information and permissions" → "Export your information" →
  "Create export" → "Export to device". [H]
- **You choose Format (JSON or HTML), Date range, and Media quality at request time, and can
  export only specific categories** (e.g., just Messages, or just your activity). **Always pick
  JSON.** [H] HTML and JSON are not interchangeable after the fact — ~74% of one tool's failed
  imports were people who picked HTML. [H]
- **Contents that matter to you:**
  - Saved: `your_instagram_activity/saved/saved_posts.json` — entries with the saved account's
    username + a permalink `href` (`/p/…` or `/reel/…`) + Unix timestamp. Sparse (no caption). [M]
  - Liked: `likes/liked_posts.json` (+ `liked_comments.json`) — permalink `href` + timestamp. [M]
  - DMs: `messages/inbox/<thread>/message_1.json` (split for long threads). A shared reel appears
    as a message with a `share` object whose **`link` field holds the reel URL** — verified by
    working parser code (`message['share']['link']`, `'reel' in link`). **This is the best-sourced
    "shared reels are recoverable" claim and the backbone of DM backfill.** [M→H]
- **Permalinks (`/p/`, `/reel/`) do NOT expire; raw CDN media URLs DO expire** quickly. Capture
  media at download time; rely on permalinks for re-fetch. [H]
- **Turnaround:** minutes to ~48h (small/single-category requests are fast). **Email notified.**
  **Download link expires ~4 days; re-requestable ~every 4 days.** [H/M]
- **No automation API for personal exports.** Meta's only DYI Export API is Workplace-only (and
  Workplace is winding down). So the request is **manual**; you can't schedule it
  programmatically. [H]

### The mojibake landmine (you will hit this)

Instagram's JSON export has a long-standing **double-encoded UTF-8 bug**: non-ASCII/emoji are
written as byte sequences like `Ä` instead of the real code point. A naive `json.load`
yields garbled text. **Fix:** reinterpret the `\u00XX` byte runs, i.e.
`garbled.encode('latin-1').decode('utf-8')` for the simple case (multi-byte needs byte
reassembly). Make this a mandatory preprocessing step in `instagram-export.ts`. [H]

> **Check against your code:** confirm `instagram-export.ts` (a) reads JSON not HTML, (b) applies
> the latin-1→utf-8 fix, (c) parses `share.link` from `messages/inbox/*/message_*.json` for
> DM-shared reels, and (d) handles file splitting (`message_1.json`, `message_2.json`, …).

Sources:
[Export how-to](https://medium.com/@noteapps/get-your-instagram-and-threads-data-a961d063c68a) ·
[Export structure](https://safeunfollow.app/docs/instagram-export) ·
[DM reel parser w/ code](https://medium.com/@jackma2333/how-to-use-python-to-compilate-the-instagram-reels-that-you-shared-with-friends-626c94dcad97) ·
[Mojibake explainer](https://krvtz.net/posts/how-facebook-got-unicode-wrong.html) ·
[Workplace DYI API only](https://developers.facebook.com/docs/workplace/reference/graph-api/dyi-export) ·
[JSON viewer parser](https://github.com/michabirklbauer/instagram_json_viewer)

---

## 3. Unofficial private-API libraries (your current `ig-bridge`)

This is the **only thing that can read your full Saved collection on a schedule.** You already
wrap **instagrapi** in `ig-bridge/main.py`.

- **instagrapi is alive and well in 2026** (`subzeroid/instagrapi`, ~6.2k★, v2.6.x shipping
  May 2026). [H] It has exactly the methods you need:
  - Saved/collections: `collections()`, `collection_pk_by_name()`, `collection_medias(pk, amount=0)`.
  - Liked: `liked_medias(amount=...)`.
  - DMs: `direct_threads()`, `direct_messages()`. [H]
- **Ban risk is real but probabilistic and IP/session-dependent.** Documented cases exist of
  accounts suspended after downloading **as few as 10 of their own saved posts** (mostly via
  *instaloader's web-cookie* path); other users run daily read scripts for a year with only
  occasional 1-day cooldowns. No one can give a real ban *rate* — enforcement is multi-signal
  (device fingerprint, IP reputation, request velocity, fresh-login triggers). [H for "risk
  exists"; M for "low at personal volume"]
- **The variables that actually drive bans** (per GitHub/Reddit threads): fresh logins & new
  devices, **VPN/datacenter/cloud IPs**, concurrent app+script sessions with mismatched
  user-agents, and tight retry loops on 429/challenge. [M-H]

### How to harden the sidecar you have

These are instagrapi's own documented best practices — apply all of them: [H for "these are the
recommendations"; M for "they prevent bans"]

1. **Login once, persist the session.** `dump_settings()` → on later runs `load_settings()` +
   `login()`, validate with `get_timeline_feed()`; on `LoginRequired`, re-login **reusing the
   same UUIDs** (`set_uuids(old["uuids"])`). Re-password-logging-in every run is the #1
   anti-pattern. *(Your `IG_SESSION_FILE` env already hints you do session persistence — verify
   UUID reuse.)*
2. **Run from the home/residential IP** that matches the account's history. **Do not** run from a
   cloud server or VPN. A residential proxy is **not** needed for one personal account. This is
   the biggest single risk lever and it argues for keeping `ig-bridge` bound to `127.0.0.1` on
   the user's own machine (which you already do).
3. **Add delays:** `cl.delay_range = [1, 3]`; sync **once a day at most**, read-only.
4. **Keep device fingerprint stable** (`set_country`, `set_locale`, device settings) across runs.
5. **Don't run the script while actively using the IG app** on the same account.
6. **Error discipline:** on `429`/`PleaseWaitFewMinutes`/`ChallengeRequired`, **cool down for
   hours**, never tight-loop. Surface challenges to the user for manual resolution (newer UFAC
   challenges can't be auto-solved).
7. Use a TOTP seed (`totp_generate_seed/code`) so 2FA stays scriptable.

### Alternatives (and why not)

- **instaloader** — maintained, *can* fetch saved posts (`--login USER :saved`), but it uses the
  **web** cookie API (the one behind the worst ban reports) and **can't read DMs**. Its own v4.15
  docs warn usage "may lead to the loss of the Instagram account." Riskier than instagrapi's
  mobile session for this job; repo has been quiet since Nov 2025. [H/M]
- **Apify / Bright Data** — commodity scrapers are **public-data only; private accounts and DMs
  are explicitly out of scope.** Fringe actors that take your session cookies run from datacenter
  IPs (the exact fingerprint mismatch that triggers checkpoints) and even their authors say "use
  a burner." The Bright Data v. Meta ruling protected **logged-off** public scraping only;
  logged-in scraping is unprotected and ToS-prohibited. **Less capable and higher risk than
  running instagrapi yourself from home.** [H]

**Verdict:** keep `ig-bridge` as an **opt-in, hardened, once-daily, localhost-only** backfill for
the Saved collection (the one thing nothing else can get automatically). Treat it as
"advanced/at-your-own-risk," not the default on-ramp. Use a dedicated/non-critical account if you
can stomach it.

Sources:
[instagrapi repo](https://github.com/subzeroid/instagrapi) ·
[Collections docs](https://subzeroid.github.io/instagrapi/usage-guide/collection.html) ·
[Best practices](https://subzeroid.github.io/instagrapi/usage-guide/best-practices.html) ·
[Ban-risk discussion](https://github.com/subzeroid/instagrapi/discussions/2224) ·
[instaloader suspension report](https://github.com/instaloader/instaloader/issues/1895) ·
[Apify IG scraper (public-only)](https://apify.com/apify/instagram-scraper) ·
[Meta v. Bright Data](https://techcrunch.com/2024/02/26/meta-drops-lawsuit-against-web-scraping-firm-bright-data-that-sold-millions-of-instagram-records/)

---

## 4. Browser & share-based capture (the friction-free front door)

For "I just saw a good reel, keep it," the best UX is the OS **share sheet**, and it's also the
**safest** path (no scraping, no private API).

- **Android — PWA `share_target`:** an installed PWA registers into the native Android share
  sheet. [H] Gotcha: on Android the shared link usually arrives in the **`text`** param (not
  `url`), so **regex-extract the URL from `text`**. [H] The Instagram app → PWA hop uses the
  standard Android share intent; works generically but **test the exact IG payload empirically**. [M]
- **iOS — `share_target` is NOT supported** by Safari/PWA. [H] **Workaround = an iOS Shortcut**
  that "Receives URLs from the Share Sheet" → "Get Contents of URL" set to **POST** to Reel
  Vault's `/api/ingest` endpoint. This is the standard, well-documented pattern (people use it for
  bookmark-savers). ~2 taps; one-time install. Coerce input to Text/URL explicitly to avoid
  occasional "couldn't convert" errors. [H]
- **Bulk-import existing Saved via a browser extension** running in **your own logged-in
  session** (the pattern of open-source `Instagram-Saver`): walks the saved grid, reads the same
  authenticated GraphQL the web app uses, exports JSON. **Lower detection than a separate mobile
  client** because it *is* your real browser on your real IP — but not zero risk, and **IG's
  internal `doc_id` rotates every 2–4 weeks**, so it needs periodic maintenance. [H mechanism /
  M risk]
- **Playwright/headless automation of instagram.com** is **higher risk** (leaks
  `navigator.webdriver`, mismatched JA3 TLS fingerprint, etc.). Reserve Playwright for
  server-side fetching of **public** URLs, not authenticated saved-crawling. [H]
- **oEmbed for title/thumbnail:** the unauthenticated oEmbed endpoint was **removed April 2025**;
  the official Meta oEmbed Read API now **requires an app access token**. [H] Anonymous `og:`-tag
  scraping is now unreliable (login wall after a few requests). [M-H] The pragmatic no-app
  enrichment is the internal web GraphQL call (`X-IG-App-ID`, `doc_id`) returning
  thumbnail/caption/video URL — unofficial and breaks on `doc_id` rotation. [M] You already have
  `src/app/api/metadata/route.ts` and `src/lib/ig.ts`; this is where that logic lives.

**Verdict:** ship the **share target** as the primary capture UX (Android `share_target` + iOS
Shortcut). It's the lowest-friction, lowest-risk on-ramp and complements the export/sidecar
backfill. You already have a `bookmarklet` page and `connect` page — fold the share target in here.

Sources:
[MDN share_target](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest/Reference/share_target) ·
[Chrome Web Share Target](https://developer.chrome.com/docs/capabilities/web-apis/web-share-target) ·
[iOS PWA limits 2026](https://www.magicbell.com/blog/pwa-ios-limitations-safari-support-complete-guide) ·
[Apple Shortcuts: request an API](https://support.apple.com/guide/shortcuts/request-your-first-api-apd58d46713f/ios) ·
[Instagram-Saver extension](https://github.com/MaxwellMetzner/Instagram-Saver) ·
[Meta oEmbed Read](https://developers.facebook.com/docs/instagram-platform/oembed/) ·
[doc_id rotation / scraping 2026](https://scrapfly.io/blog/posts/how-to-scrape-instagram)

---

## 5. The AI pipeline (summarize + categorize each reel)

The download stage is the only fragile/risky part; everything downstream is cheap and stable.

**Stage 1 — Get the video (fragile).** `yt-dlp` **needs authenticated cookies** for Instagram in
2026 (`--cookies-from-browser chrome` or an exported cookies file); without login it hits the
login wall. [H] Keep yt-dlp pinned to nightly and fall back yt-dlp → gallery-dl → instaloader.
Low frequency, no parallelism. For items shared via DM/Self-Messaging you often already have a CDN
media URL from the webhook, skipping this stage. [M-H]

**Stage 2 — Transcribe (cheap/free).** Per ~60s reel:

| Option | Cost / reel | Note |
|---|---|---|
| **Local whisper.cpp (Metal on Apple Silicon)** | **$0** | ~10× realtime on large-v3; `small` is instant. Best default for a personal app. [H] |
| **Groq `whisper-large-v3-turbo`** | **~$0.0007** | Hosted, trivially cheap. [H] |
| OpenAI `gpt-4o-mini-transcribe` | $0.003 | [H] |

**Stage 3 — Understand + classify (one call).** **Gemini Flash is the standout because it's the
only major API with native video input** (sees motion + on-screen text + hears audio in one
call). Per ~60s reel: **Gemini 3.1 Flash-Lite ≈ $0.006**, Gemini 3 Flash ≈ $0.011; **Flash/
Flash-Lite have a free daily tier** (~1,500 req/day), so a personal volume is often **$0**. [H]
Claude has no native video; the frame-based approach (ffmpeg keyframes + transcript) works as a
fallback at ~$0.01 (Haiku) to ~$0.035 (Sonnet)/reel. [M-H]

**Categorization best practice:** for a **fixed personal taxonomy** (anime, movies, AI news, AI
tools, …) use **LLM zero-shot classification with the label list in the prompt**, not embedding
clustering (clustering discovers groups, it doesn't map to *your* labels). Do
**summary + category + tags in one structured-output call** with a JSON schema: `category` as an
**enum** (forces the fixed set, include an `"unsorted"` escape hatch), `tags` as a free array.
All providers support schema-constrained JSON. [H] You already have `src/lib/ai.ts` and
`api/enrich` / `api/enrich-pending` routes — this is exactly where this slots in.

**Stage 4 — Semantic search (Supabase pgvector).** pgvector is first-class on Supabase. Use
Supabase's official **hybrid search** recipe: a generated `tsvector` column (you already have FTS
in `0001_reel_vault_schema.sql`) **+** a `vector(1536)` column, merged with **Reciprocal Rank
Fusion**. Embeddings are ~$0.02–0.03 to embed **1,000 reels** (`text-embedding-3-small` or
`voyage-3.5-lite` at $0.02/M) — negligible. [H] This upgrades your current keyword-only search to
"find that pasta reel" semantic recall.

**Total AI cost per reel:** ~$0.00 (Gemini free tier + local whisper) to ~$0.011 paid. The hoard
is affordable; budget your effort on the download/connection reliability, not the AI bill.

Sources:
[yt-dlp IG needs cookies](https://github.com/yt-dlp/yt-dlp/issues/16311) ·
[Groq pricing](https://groq.com/pricing) ·
[whisper.cpp](https://github.com/ggml-org/whisper.cpp) ·
[Gemini video understanding](https://ai.google.dev/gemini-api/docs/video-understanding) ·
[Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing) ·
[LLM zero-shot classification](https://arxiv.org/pdf/2312.01044) ·
[Supabase hybrid search](https://supabase.com/docs/guides/ai/hybrid-search) ·
[Supabase pgvector](https://supabase.com/docs/guides/database/extensions/pgvector)

---

## 6. Recommended architecture for Reel Vault

A layered design that matches your "honest about limits, private by default, retrieval over feed"
principles. Each layer is independent; ship them in order.

```
            ┌─────────────────────── CAPTURE LAYER (pick what you'll actually use) ──────────────────────┐
            │                                                                                             │
 [Instant]  │  Android: PWA share_target  ─┐                                                              │
 [Instant]  │  iOS: Shortcut → POST        ─┼──►  /api/ingest  (URL in)                                   │
 [Official] │  Self-Messaging webhook      ─┘     (reel shared to self → echo webhook, is_self:true)      │
            │                                                                                             │
 [Backfill] │  DYI export ZIP  ──►  /api/ingest (ExportConnector: saved_posts, liked_posts, DM share.link)│
 [Opt-in]   │  ig-bridge (instagrapi, localhost, 1×/day) ──► Saved collection + DM threads                │
            └──────────────────────────────────────────────┬──────────────────────────────────────────┘
                                                            │  (dedup by url — items.url is UNIQUE)
                                                            ▼
                                        Supabase  reel_vault.items / conversations / messages
                                                            │
                                                            ▼  enqueue origin+url, status=pending
                            ENRICHMENT WORKER  (api/enrich-pending, cron)
                            1. fetch video (yt-dlp+cookies)  or  use webhook CDN url
                            2. transcribe (whisper.cpp local / Groq)
                            3. Gemini Flash: {summary, category(enum), tags[]}  + thumbnail
                            4. embed (text-embedding-3-small) → items.embedding vector(1536)
                                                            │
                                                            ▼
                            UI: masonry grid, category filters, HYBRID search (FTS + pgvector RRF)
```

### Connection methods, ranked for this app

| Method | Gets saved? | Gets liked? | Gets DM reels? | Auto? | Ban risk | ToS | Effort |
|---|---|---|---|---|---|---|---|
| **DYI export (have it)** | ✅ (links) | ✅ (links) | ✅ (`share.link`) | ❌ manual | none | ✅ | low |
| **Share target (build next)** | manual save | manual save | n/a | per-item | none | ✅ | low |
| **Self-Messaging (build, official)** | re-share to self | re-share to self | ✅ live | ✅ webhook | none | ✅ | med (Pro acct + app + webhook) |
| **instagrapi sidecar (have it)** | ✅ full auto | ✅ | ✅ | ✅ 1×/day | **real** | ❌ | have it |
| Browser extension | ✅ bulk | partial | n/a | semi | low-med | ❌ | med |
| Apify/Bright Data | ❌ | ❌ | ❌ | — | high | ❌ | n/a |

### Concrete roadmap

1. **Harden what you have (now).** Make `ig-bridge` opt-in + localhost-only (already bound to
   127.0.0.1 — good), enforce session+UUID reuse, `delay_range`, once-daily, cooldown on
   challenge. Verify `instagram-export.ts` does the mojibake fix and parses `share.link`.
2. **Add the share target (highest UX win, zero risk).** Android `share_target` in the PWA
   manifest (parse URL from `text`); publish an iOS Shortcut that POSTs to `/api/ingest`. Reuse
   your existing `connect`/`bookmarklet` pages.
3. **Add AI enrichment depth.** Wire `api/enrich-pending` to: yt-dlp(+cookies) → whisper.cpp →
   Gemini Flash structured `{summary, category, tags}`. Make the taxonomy a config enum
   (anime, movies, AI news, AI tools, recipes, …, unsorted).
4. **Add semantic search.** `create extension vector;`, add `embedding vector(1536)` to
   `reel_vault.items`, backfill embeddings, swap search to the Supabase hybrid (FTS + RRF) RPC.
5. **(Optional, official live DM) Self-Messaging.** Convert to a free Professional account, create
   a Standard-Access app with Instagram Login, subscribe the `messages` webhook, capture
   `ig_reel` self-shares. This is the only *ToS-clean automatic* live capture — worth it if you
   want to retire the instagrapi DM path.

### Ban-risk bottom line

- **DYI export, share target, and Self-Messaging carry no account risk** — they're official or
  user-initiated. Make these the spine.
- **instagrapi is the only unofficial piece.** For a single account, read-only, once-daily, from
  your home IP with a persisted session, real-world reports suggest **low** risk — but it is
  **non-zero and irreversible** (permanent bans have happened). Keep it opt-in, off by default,
  ideally on an account you can afford to lose, and never run it from a cloud host or VPN.

---

## Key uncertainties / things to test empirically

- Exact top-level JSON keys in a *fresh* 2026 export (`saved_saved_media`, `likes_media_likes`)
  are reconstructed from parsers — **verify against a real export before hard-coding.** [L-M]
- Whether Instagram's **app share sheet** populates `text` vs `title` for a reel into an Android
  PWA — test on device. [M]
- `doc_id` rotation will break any unofficial web-GraphQL metadata fetch every 2–4 weeks — needs
  a refresh plan. [H]
- yt-dlp's Instagram extractor breaks periodically — keep fallbacks. [H]

---

## Full source list

Official Meta: [Platform overview](https://developers.facebook.com/docs/instagram-platform/overview),
[Changelog](https://developers.facebook.com/docs/instagram-platform/changelog),
[Conversations API](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/conversations-api),
[Self Messaging](https://developers.facebook.com/docs/instagram-platform/self-messaging),
[Webhooks examples](https://developers.facebook.com/docs/instagram-platform/webhooks/examples),
[oEmbed](https://developers.facebook.com/docs/instagram-platform/oembed/),
[Basic Display shutdown](https://developers.facebook.com/blog/post/2024/09/04/update-on-instagram-basic-display-api/),
[Workplace DYI API](https://developers.facebook.com/docs/workplace/reference/graph-api/dyi-export).

Export: [how-to](https://medium.com/@noteapps/get-your-instagram-and-threads-data-a961d063c68a),
[structure](https://safeunfollow.app/docs/instagram-export),
[DM reel parser](https://medium.com/@jackma2333/how-to-use-python-to-compilate-the-instagram-reels-that-you-shared-with-friends-626c94dcad97),
[mojibake](https://krvtz.net/posts/how-facebook-got-unicode-wrong.html),
[json viewer](https://github.com/michabirklbauer/instagram_json_viewer).

Private API: [instagrapi](https://github.com/subzeroid/instagrapi),
[collections](https://subzeroid.github.io/instagrapi/usage-guide/collection.html),
[best practices](https://subzeroid.github.io/instagrapi/usage-guide/best-practices.html),
[ban discussion](https://github.com/subzeroid/instagrapi/discussions/2224),
[instaloader suspension](https://github.com/instaloader/instaloader/issues/1895),
[instaloader ban threats](https://github.com/instaloader/instaloader/issues/2555),
[Apify scraper](https://apify.com/apify/instagram-scraper),
[Meta v. Bright Data](https://techcrunch.com/2024/02/26/meta-drops-lawsuit-against-web-scraping-firm-bright-data-that-sold-millions-of-instagram-records/).

Capture: [MDN share_target](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest/Reference/share_target),
[Chrome Web Share Target](https://developer.chrome.com/docs/capabilities/web-apis/web-share-target),
[iOS PWA limits](https://www.magicbell.com/blog/pwa-ios-limitations-safari-support-complete-guide),
[Apple Shortcuts API](https://support.apple.com/guide/shortcuts/request-your-first-api-apd58d46713f/ios),
[Instagram-Saver](https://github.com/MaxwellMetzner/Instagram-Saver),
[scraping 2026 / doc_id](https://scrapfly.io/blog/posts/how-to-scrape-instagram).

AI pipeline: [yt-dlp IG cookies](https://github.com/yt-dlp/yt-dlp/issues/16311),
[Groq pricing](https://groq.com/pricing),
[whisper.cpp](https://github.com/ggml-org/whisper.cpp),
[Gemini video](https://ai.google.dev/gemini-api/docs/video-understanding),
[Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing),
[LLM zero-shot](https://arxiv.org/pdf/2312.01044),
[Supabase hybrid search](https://supabase.com/docs/guides/ai/hybrid-search),
[Supabase pgvector](https://supabase.com/docs/guides/database/extensions/pgvector).
