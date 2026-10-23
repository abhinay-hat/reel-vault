# Zero-spend offline pipeline: Phase 1 design

**Date:** 2026-10-06
**Status:** approved direction, ready to build
**Plan doc:** "Reel Vault × reel-watcher: merged product plan" (claude.ai doc)
**Work packets:** `docs/superpowers/plans/2026-10-06-phase1-work-packets.md`

## 1. Goal

Make all 396 vault items searchable by filling `caption`, `transcript`, `ocr_text`, `summary`, `category`, `tags`, `entities` and `actions`, **without ever spending money** and without logging in to Instagram.

- **Fetch** uses Apify's Free plan (no card attached; blocked, never billed, when the $5 monthly credit is used up).
- **Everything else runs on this Mac**, offline: ffmpeg keyframes, Apple Vision OCR + Tesseract (Hindi, Telugu), mlx-whisper, and Qwen3-4B on `mlx_lm.server` for enrichment.
- About 3 GB of model downloads. Videos are deleted after processing.

### Hard rules (non-negotiable, every packet)

1. **No paid call is reachable from code.** Remove the Anthropic vision path in `pipeline/extract.py` (`read_frames`, `ANTHROPIC_KEY`, `VISION_MODEL`). No Apify paid add-ons. No model id outside the allow-list (§6).
2. **Never log in to Instagram** in the default path. The sidecar fetcher stays, opt-in only (`--fetcher sidecar`).
3. **Keep the existing status machine**: `pending → fetched → transcribed → enriched`, plus `failed` and `unavailable`. Do not rename statuses; `listItemsNeedingEnrichment` in `src/lib/db.ts` depends on `transcribed`.
4. **Additive migrations only**, mirrored in `src/lib/db.ts` and `pipeline/` (both idempotent, as today).
5. **Resumable and Ctrl-C safe**, as today: commit per item.
6. **Credit reel-watcher.** Code ported from https://github.com/jakeb144/reel-watcher (MIT, © Jacob Bruce) keeps a header comment naming the source file, and `THIRD_PARTY_NOTICES.md` carries its licence text.

## 2. Current state (what exists)

- `pipeline/extract.py` (single file): sidecar caption fetch → video download → faster-whisper → **paid** Anthropic frame reading. Statuses as above.
- `src/lib/db.ts` already declares `caption, transcript, ocr_text, entities, actions, content_status, content_error, media_file, video, video_file`. The live DB at `data/reel-vault.db` does **not** have them yet (the app has not run since); whichever side runs first applies them.
- `src/app/api/enrich-pending/route.ts` enriches 20 `transcribed` items per POST via `src/lib/llm.ts` → Groq `llama-3.3-70b-versatile`, which is **not on Groq's free plan any more**.
- `src/lib/ai.ts` owns `buildKnowledgePrompt` / `parseKnowledgeResponse` (tested). Keep them as the single source of the prompt.

## 3. Target layout

```
pipeline/
  extract.py                 # CLI entry (thin): parses args, runs the loop
  start-extract.command      # unchanged entry; now uses pipeline/.venv
  start-llm.command          # NEW: runs mlx_lm.server for enrichment
  setup.sh                   # NEW: one-time install, idempotent
  requirements.txt           # platform markers (see §8)
  tessdata/                  # NEW, gitignored: hin + tel traineddata
  reelvault/
    __init__.py
    db.py                    # connect, migrations, queue, save, quota_ledger
    guardrails.py            # allow-list, Apify credit meter, disk check
    fetch_apify.py           # Apify Free-plan fetcher
    fetch_sidecar.py         # today's fetch_caption(), moved unchanged
    media.py                 # download, probe, scene cuts, keyframes, dhash
    ocr.py                   # Apple Vision + Tesseract, merged text
    transcribe.py            # mlx-whisper (Mac) / faster-whisper (fallback)
    process.py               # per-item orchestration
  tests/                     # pytest, no network, no models
scripts/
  enrich-all.sh              # NEW: POST /api/enrich-pending until 0 left
THIRD_PARTY_NOTICES.md       # NEW
```

## 4. Data model

Additive columns on `items` (add to **both** `src/lib/db.ts` and `pipeline/reelvault/db.py`):

| Column | Type | Set by | Meaning |
|---|---|---|---|
| `keyframe_file` | text | process | One JPEG under `data/media/`, the first content frame (t≈1.0 s) |
| `duration_s` | real | fetch | From Apify `videoDuration` or ffprobe |
| `music` | text (JSON) | fetch | `{"song":..,"artist":..,"original":bool}` from Apify `musicInfo`, else null |
| `fetcher` | text | fetch | `apify` or `sidecar` |

New table (pipeline side only; the app reads it in Phase 2):

```sql
create table if not exists quota_ledger (
  id integer primary key autoincrement,
  at text not null,              -- ISO timestamp
  provider text not null,        -- 'apify'
  run_id text,
  items integer not null default 0,
  usd_reported real,             -- usageTotalUsd of the run (credit, not money)
  monthly_usage_after real,      -- data.current.monthlyUsageUsd after the run
  note text
);
```

Existing columns reused: `caption`, `video` (remote URL, re-fetch source), `video_file` (set while the video exists, cleared after deletion), `thumbnail`, `author`, `title`, `transcript`, `ocr_text`, `content_status`, `content_error`.

## 5. Per-item flow

```
pending ──fetch──▶ fetched ──download+frames+ocr+transcribe──▶ transcribed ──enrich (app)──▶ enriched
   │                  │                                              
   └─ unavailable     └─ failed (content_error says why; retried next run, never in the same run)
```

0. **Normalise URLs.** Stored URLs carry query strings (`/reel/<code>/?id=…&is_sponsored=…`). Send Apify `https://www.instagram.com/<reel|p>/<code>/` and match results back by shortcode. The vault holds 386 DM-shared items: 265 `/reel/` and 121 `/p/` posts, plus 10 saved reels.
1. **Fetch (batch of 15).** Apify returns caption, `videoUrl`, `displayUrl`, `ownerUsername`, `timestamp`, `videoDuration`, `musicInfo`. Map exactly like today's sidecar mapping (title rule: replace a `Shared by …` placeholder with the caption's first line, ≤120 chars; set `thumbnail` only if empty; set `author`). Set `content_status='fetched'`, `fetcher='apify'`.
   - Missing in Apify's output or `error` set → `unavailable` with the reason.
2. **Download immediately** (signed CDN links expire within hours): `data/media/<md5(item_id)>.mp4`, as `download_video` does today.
3. **Frames.** Port from reel-watcher `study.py`: `HOOK_TIMES = [0.0, 0.5, 1.0, 1.5, 2.0, 2.5]`, scene cuts (`media.detect_cuts`, threshold 0.30), `pick_later_times`, `extract_frames_at` (scale to ≤896 px), `dhash_bits`, `text_changed`, `dedupe_frames` (cap 9 unique frames). OCR runs before dedupe so `text_changed` can use it.
4. **OCR** per frame, then merged across unique frames in time order, deduped line by line (normalised text), capped at 2,000 chars:
   - Apple Vision `VNRecognizeTextRequest`, accurate level, language correction on (port `ocr_image`, including `_SECRET_RE` redaction).
   - Tesseract with `--tessdata-dir pipeline/tessdata -l hin+tel`; **keep only lines containing Devanagari (U+0900–U+097F) or Telugu (U+0C00–U+0C7F)** characters, so Tesseract's noisy Latin output never pollutes Apple's.
   - If Vision is unavailable (non-Mac), use Tesseract `eng+hin+tel` for everything.
5. **Transcribe**: mlx-whisper, model `REEL_VAULT_WHISPER_MODEL` (default `mlx-community/whisper-small-mlx`), language auto-detect. Keep today's rules: text under 15 chars → empty (music-only reel); prefix `[<lang>] ` when language ≠ en. Fallback on non-Mac: faster-whisper `small`, int8, CPU (today's code).
6. **Keyframe**: copy the unique frame nearest t=1.0 s to `data/media/<md5(item_id)>_k.jpg`; set `keyframe_file`, and also `media_file` when it is empty (the app shows `media_file` as the thumbnail; Apify's `displayUrl` expires).
   - **Image posts** (`/p/` without a video): download `displayUrl` and up to 9 `childPosts[].displayUrl` / `images[]`, OCR each, keyframe = first image, no transcript. A carousel child with `videoUrl` is processed as the video.
7. **Save** `transcript`, `ocr_text`, `keyframe_file`, `duration_s`, `content_status='transcribed'`, `content_error=null`.
8. **Delete the video** and clear `video_file`, unless `KEEP_MEDIA=1`. Keep `video` (remote URL).
9. **Enrich** happens in the app (unchanged route) against the local LLM (§7).

Partial failure policy (as today): a transcription error still saves OCR and moves to `transcribed` with `content_error` noting it; a download failure → `failed`.

## 6. Guardrails (`pipeline/reelvault/guardrails.py`)

All pure functions + one HTTP call each, unit-tested.

| Guard | Rule |
|---|---|
| **Free-plan check** | `GET https://api.apify.com/v2/users/me/limits` (Bearer `APIFY_TOKEN`). Abort the whole run if `data.limits.maxMonthlyUsageUsd > 5`; that means a paid plan, and a paid plan can bill. Message tells the user to use a free account. |
| **Credit meter** | Before each batch: `used = data.current.monthlyUsageUsd`. Estimated batch cost = `n × 0.003 + 0.001`. Proceed only if `used + estimate ≤ 4.50`. Otherwise stop cleanly and print the next cycle date from `data.monthlyUsageCycle.endAt`. |
| **Per-run cap** | Every actor run is started with `?maxTotalChargeUsd=<min(4.50 − used, estimate × 1.5)>` rounded down to cents. |
| **No add-ons** | Actor input is exactly `{"directUrls": [...], "resultsType": "posts", "resultsLimit": 1, "addParentData": false}`; the actor id is `apify~instagram-scraper`. Nothing else is configurable. |
| **Model allow-list** | `ALLOWED_LLM_MODELS = {local: ["mlx-community/Qwen3-4B-Instruct-2507-4bit"], groq: ["openai/gpt-oss-120b", "openai/gpt-oss-20b"]}`. Mirrored in `src/lib/llm.ts`; anything else throws at startup. |
| **Disk** | Before each batch, abort if free space on the `data/` volume < 3 GB (`shutil.disk_usage`). |
| **Rate limits** | Any HTTP 429 / quota error → sleep for `Retry-After` (or 60 s), max 3 times, then stop the run. Never switch provider or model. |
| **Ledger** | Each Apify run appends a `quota_ledger` row. |

`--dry-run` (the default when `--run` is absent) prints: items queued, batches, estimated credit, credit used this cycle, credit left, free disk. It makes **no** actor run (the limits GET is allowed).

## 7. Enrichment on the Mac (`src/lib/llm.ts`)

Replace the hard-coded Groq URL with an OpenAI-compatible provider switch:

| Env | Default | Meaning |
|---|---|---|
| `LLM_PROVIDER` | `local` | `local` or `groq` |
| `LLM_BASE_URL` | `http://127.0.0.1:8090/v1` when local; `https://api.groq.com/openai/v1` when groq | |
| `LLM_MODEL` | `mlx-community/Qwen3-4B-Instruct-2507-4bit` (local) / `openai/gpt-oss-120b` (groq) | must be in the allow-list |
| `GROQ_API_KEY` | none | required only for groq |

- `llmEnabled()` → true when provider is local (server reachability is checked per call) or when groq + key.
- POST `${LLM_BASE_URL}/chat/completions` with `{model, max_tokens, temperature: 0.2, messages}`; same response parsing as today.
- `pipeline/start-llm.command`: `exec pipeline/.venv/bin/python -m mlx_lm.server --model mlx-community/Qwen3-4B-Instruct-2507-4bit --host 127.0.0.1 --port 8090`.
- `scripts/enrich-all.sh`: loop `curl -s -X POST http://localhost:3210/api/enrich-pending` until the response has `"enriched":0`; print a running total; stop on 3 consecutive failures.
- `buildKnowledgePrompt` / `parseKnowledgeResponse` stay unchanged. If the 4B model's JSON fails `parseKnowledgeResponse` on more than 2 of the first 10 items, raise it in review; do not loosen the parser.

## 8. Setup (`pipeline/setup.sh`)

Idempotent; prints what it did and free disk at the end.

1. Check `brew`, then `brew install ffmpeg tesseract` if missing.
2. Create `pipeline/.venv` with Python **≥ 3.11** (mlx-lm 0.32 requires it; arm64 on Mac). Prefer `uv venv --python 3.12` when `uv` exists, else Homebrew `python3.12`. macOS's `/usr/bin/python3` is too old.
3. `pip install -r pipeline/requirements.txt`:
   ```
   requests>=2.31
   pillow>=11
   pytesseract>=0.3.13
   mlx-whisper>=0.4.3 ; sys_platform == "darwin" and platform_machine == "arm64"
   mlx-lm>=0.32 ; sys_platform == "darwin" and platform_machine == "arm64"
   pyobjc-framework-Vision>=10 ; sys_platform == "darwin"
   faster-whisper>=1.0.3 ; sys_platform != "darwin"
   pytest>=8
   ```
   (mlx-lm 0.32.0 is current as of 2026-10-06 and needs Python ≥ 3.11; it pulls in transformers, a few hundred MB.)
4. Download `hin.traineddata` and `tel.traineddata` from `https://github.com/tesseract-ocr/tessdata_fast/raw/main/` into `pipeline/tessdata/` (skip if present). Copy `eng.traineddata` from Homebrew's tessdata dir for the non-Mac fallback.
5. Respect `HF_HOME` if set; otherwise print that models will go to `~/.cache/huggingface` and how to move them.
6. `.gitignore`: add `pipeline/.venv/`, `pipeline/tessdata/`, `data/media/*.mp4`.

`start-extract.command` switches `python3` to `pipeline/.venv/bin/python` and passes `--fetcher apify` by default.

## 9. CLI (`pipeline/extract.py`)

```
python pipeline/extract.py --stats
python pipeline/extract.py --limit 10            # dry run (default)
python pipeline/extract.py --limit 10 --run      # real run
python pipeline/extract.py --run --fetcher sidecar   # opt-in, ban risk warning printed
python pipeline/extract.py --run --retry-failed  # include failed items
flags: --keep-media, --batch 15
```

- Default queue excludes `failed` unless `--retry-failed` (today it includes them; change it, as reel-watcher does, so a broken item can't burn credit every run).
- `APIFY_TOKEN` comes from the environment / `.env.local` only; never logged or written.
- `--stats` adds: credit used this cycle, items per status, free disk.

## 10. Tests (`pipeline/tests/`, pytest, no network, no models)

- guardrails: free-plan check, credit math at the 4.50 boundary, per-run cap rounding, allow-list.
- Apify item mapping: title rule, thumbnail only-if-empty, missing item → unavailable, `musicInfo` → `music`.
- media: `pick_later_times`, `dedupe_frames`, `text_changed` (ported tests welcome).
- ocr merge: script filter keeps Devanagari/Telugu lines only, dedupe across frames, 2,000 cap, secret redaction.
- db: migrations idempotent on a temp DB created from `src/lib/db.ts`'s schema; status transitions; `--retry-failed` queue.
- transcribe: the <15-char rule and `[lang]` prefix with a faked model.
- Vitest: `llm.ts` provider switch + allow-list (mock `fetch`).

## 11. Acceptance (Phase 1 gate)

1. `pipeline/setup.sh` completes on the Mac; total new downloads ≤ 3.5 GB.
2. `extract.py --limit 10` dry run shows credit numbers and makes no actor run.
3. `extract.py --limit 10 --run` → 10 items `transcribed`, videos deleted, a keyframe each, one `quota_ledger` row.
4. With `start-llm.command` and `npm run dev` running, `scripts/enrich-all.sh` → those 10 `enriched` with non-empty summaries.
5. Owner spot-checks the 10 against the videos.
6. Full run: all 386 DM-shared items reach `transcribed` or `unavailable`; Apify `monthlyUsageUsd` stays ≤ 4.50; nothing billed.
7. `pytest pipeline/tests` and `npm test` pass.
