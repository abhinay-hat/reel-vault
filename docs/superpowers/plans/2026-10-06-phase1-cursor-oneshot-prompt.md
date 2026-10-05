# Cursor one-shot prompt: Phase 1, zero-spend offline pipeline

How to use: open a terminal in `~/Projects/Experimental/reel-vault`, start Cursor's agent, and paste everything between the two `=====` lines as the task. It is written to run end to end without stopping.

=====

You are building Phase 1 of Reel Vault's content pipeline, end to end, autonomously. Do not stop to ask questions and do not wait for approval between phases. When something is ambiguous, pick the option most consistent with the spec and the HARD RULES, write the choice to `docs/superpowers/plans/2026-10-06-phase1-decisions.md` (one line each: what, why), and keep going. Only stop early if a HARD RULE would be broken; then write why to the decisions file and finish the final report.

## 0. What you are building, in one paragraph

Reel Vault (this repo, Next.js 16 + local SQLite) holds 396 saved Instagram items, 386 of them DM-shared reels/posts that arrived as bare links titled "Shared by <id>" with no content. Phase 1 fills each item's caption, transcript, on-screen text and AI summary/category/tags/entities/actions, spending exactly ₹0: Apify's Free plan (no card; blocked, never billed, once the $5 monthly credit is used) fetches the caption + media URL; everything else runs offline on this Mac (16 GB M4 Pro, Apple Silicon, about 20 GB free disk): ffmpeg keyframes, Apple Vision OCR + Tesseract Hindi/Telugu, mlx-whisper speech-to-text, and a local Qwen3-4B on `mlx_lm.server` for enrichment.

## 1. Read these first, in this order

1. `docs/superpowers/specs/2026-10-06-zero-spend-offline-pipeline-design.md`: THE SPEC. It wins over this prompt if they ever disagree, except for the HARD RULES below.
2. `CLAUDE.md` and `AGENTS.md`: repo conventions. Next.js 16.2.6 differs from older versions; read `node_modules/next/dist/docs/` before touching framework code (you should barely need to).
3. `pipeline/extract.py`: today's pipeline. You will split it into a package.
4. `src/lib/db.ts` (lines ~100–175 migrations; `listItemsNeedingEnrichment`), `src/lib/llm.ts`, `src/lib/ai.ts` (`buildKnowledgePrompt`, `parseKnowledgeResponse`), `src/app/api/enrich-pending/route.ts`, `src/lib/media.ts`.
5. `docs/reference/reel-watcher/study.py`, `media.py`, `LICENSE`: MIT code (commit 7a309a3 of github.com/jakeb144/reel-watcher) to PORT from. Reference only; never import it.
6. `docs/KNOWLEDGE-BASE.md`: user-facing pipeline doc you will update at the end.

## 2. HARD RULES (never break these)

1. **No money, ever.** No code path may call a paid service. Specifically:
   - Delete the Anthropic vision path in `pipeline/extract.py` (`read_frames`, `ANTHROPIC_KEY`, `VISION_MODEL`, the `api.anthropic.com` call). `.env.local` DOES contain `ANTHROPIC_API_KEY`, and `start-extract.command` sources `.env.local`, so this path is live today. After your change, `grep -rn "anthropic" pipeline/` must return nothing.
   - Apify: only actor `apify~instagram-scraper`, only the input in §5.3. No add-ons, no other actors.
   - LLM: only models in the allow-list (§5.2). Groq's `llama-3.3-70b-versatile` is NOT on Groq's free plan any more; remove it as a default.
2. **Never log in to Instagram** in the default path. The sidecar fetcher stays opt-in (`--fetcher sidecar`), never default.
3. **Status names are fixed:** `pending`, `fetched`, `transcribed`, `enriched`, `failed`, `unavailable`. `listItemsNeedingEnrichment` in `src/lib/db.ts` selects `content_status = 'transcribed'`.
4. **Migrations are additive and idempotent**, mirrored in `src/lib/db.ts` and `pipeline/reelvault/db.py`. Never drop, rename or rewrite existing columns or data.
5. **Never print or write secrets** (`APIFY_TOKEN`, `GROQ_API_KEY`, anything from `.env.local`). Read tokens from the environment only.
6. **Never delete user data.** The only files you may delete at runtime are videos the pipeline itself downloaded into `data/media/` (and its own temp files). Back up the DB before any real run: `cp data/reel-vault.db data/reel-vault.db.bak-phase1` (once; skip if it exists).
7. **Credit reel-watcher.** Every ported function keeps a comment `# Ported from reel-watcher (MIT, © 2026 Jacob Bruce): src/reel_watcher/<file>.py`. Add `THIRD_PARTY_NOTICES.md` with the full LICENSE text.
8. Tests never touch the network or load real models.

## 3. Verified groundwork facts (checked 2026-10-06; rely on them)

**Repo / data**
- Git: branch `build-reel-vault`, HEAD `982f001`, with uncommitted user changes (README, package.json, globals.css, a deleted `src/app/bookmarklet/page.tsx`, etc.). Do not revert or "fix" them.
- `data/reel-vault.db` has 396 rows in `items`: origin `dm_shared` + `/reel/` = 265, `dm_shared` + `/p/` = 121, `saved` + `/reel/` = 10. 267 titles start with `Shared by `.
- The live DB currently has ONLY these `items` columns: `id, url, source, title, author, thumbnail, summary, category, tags, notes, origin, created_at, added_at, media_file, video, video_file`. The columns `db.ts` declares (`caption, transcript, ocr_text, entities, actions, content_status, content_error`) are not applied yet; the Python migration must add them too. `content_status` default `'pending'` makes all 396 queued.
- Stored URLs carry query strings, e.g. `https://www.instagram.com/reel/DY4ZdXVP1qa/?id=3906984645824043674_50056993869&is_sponsored=false&…`. Item ids are UUIDs.
- Media files live in `data/media/` (`REEL_VAULT_MEDIA` overrides, see `src/lib/media.ts`). The app renders `media_file` as the thumbnail and `video_file` as the playable video. Existing download naming: `md5(item_id).mp4`.
- `.env.local` keys present: `ANTHROPIC_API_KEY`, `GROQ_API_KEY`, `SHARE_TOKEN`, Supabase leftovers, `APP_PASSCODE` (commented out). `APIFY_TOKEN` is NOT there yet; the owner will add it.
- `vitest.config.ts` uses default include (`**/*.test.ts`), `passWithNoTests: true`, alias `@` → `src`.
- Scaffold already present: `pipeline/reelvault/__init__.py`, `pipeline/tests/conftest.py` (adds `pipeline/` to `sys.path`, so tests `import reelvault`).

**Apify** (docs.apify.com; reel-watcher uses the same calls)
- Start run: `POST https://api.apify.com/v2/acts/apify~instagram-scraper/runs?maxTotalChargeUsd=<cap>` with header `Authorization: Bearer <APIFY_TOKEN>`, `Content-Type: application/json`, body `{"directUrls": [...], "resultsType": "posts", "resultsLimit": 1, "addParentData": false}` → `{"data": {"id", "status", "defaultDatasetId", ...}}`.
- Poll: `GET https://api.apify.com/v2/actor-runs/<runId>` every 5 s while status is `READY` or `RUNNING`; give up after 900 s. Success = `SUCCEEDED`; anything else is a run failure (`statusMessage` explains). `usageTotalUsd` on the run = credit used.
- Items: `GET https://api.apify.com/v2/datasets/<datasetId>/items?clean=true&format=json` → list.
- Item fields used: `shortCode`, `url`, `caption`, `videoUrl`, `displayUrl`, `images` (list of URLs), `childPosts` (list with `displayUrl`, `videoUrl`), `ownerUsername`, `timestamp`, `videoDuration`, `musicInfo` (`song_name`, `artist_name`, `uses_original_audio`), `error`, `errorDescription`. Treat any missing field as absent; numbers can be negative sentinels (ignore < 0).
- Limits: `GET https://api.apify.com/v2/users/me/limits` → `data.current.monthlyUsageUsd`, `data.limits.maxMonthlyUsageUsd`, `data.monthlyUsageCycle.endAt`. Free plan = $5 a month; `apify~instagram-scraper` costs $2.70 per 1,000 results on Free (we budget $0.003 per item + $0.001 per run start).
- CDN media URLs are signed and expire within hours: download immediately after the batch returns. Use header `User-Agent: Mozilla/5.0`.

**Local ML (Apple Silicon)**
- `mlx-lm` 0.32.0 (current) needs **Python ≥ 3.11**; console script `mlx_lm.server` (also `python -m mlx_lm.server`), flags `--model --host --port`; OpenAI-compatible `POST /v1/chat/completions`, response `choices[0].message.content`. Model: `mlx-community/Qwen3-4B-Instruct-2507-4bit` (non-thinking instruct, ~2.3 GB).
- `mlx-whisper` 0.4.3: `import mlx_whisper; r = mlx_whisper.transcribe(path, path_or_hf_repo="mlx-community/whisper-small-mlx")` → dict with `text`, `language`, `segments`. Needs ffmpeg on PATH. Model ~0.48 GB.
- Apple Vision via `pyobjc-framework-Vision` (`import Vision`; `from Foundation import NSURL, NSDictionary`), see `ocr_image` in the reference `study.py`.
- Tesseract: `brew install tesseract` ships `eng`. Hindi/Telugu fast models: `https://github.com/tesseract-ocr/tessdata_fast/raw/main/hin.traineddata` (1.07 MB) and `.../tel.traineddata` (2.64 MB). Use `pytesseract.image_to_string(img, lang="hin+tel", config=f'--tessdata-dir "{dir}"')`. `pytesseract` 0.3.13.
- HF models cache under `$HF_HOME` or `~/.cache/huggingface`.

## 4. Workflow

- **Phase 0 (git):** run `git status`. Commit the user's existing uncommitted changes as-is: `git add -A && git commit -m "wip: snapshot before phase 1"` (include the spec/plan docs and scaffold). Then `git switch -c phase1/zero-spend-pipeline`. After each phase below passes its checks, commit with message `phase1: <phase name>`. Never push. Never rewrite history.
- After every phase run its tests. If something fails, fix it before moving on (up to 5 attempts per failure; if still failing, record it in the decisions file and continue with what does not depend on it).
- Keep code style consistent with `pipeline/extract.py`: explanatory docstrings that say WHY, small functions, `from __future__ import annotations`, type hints.

## 5. Phases

### Phase 1: environment + setup script
1. Detect Python: if `uv` exists, `uv venv --python 3.12 pipeline/.venv`; else if `python3.12` or `python3.11` exists (Homebrew `/opt/homebrew/bin`), `python3.1x -m venv pipeline/.venv`; else `brew install python@3.12` and use it. Never use `/usr/bin/python3` (too old).
2. Write `pipeline/requirements.txt`:
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
3. Write `pipeline/setup.sh` (bash, `set -euo pipefail`, idempotent, chmod +x): checks Homebrew; installs `ffmpeg` and `tesseract` if missing; creates the venv per step 1 if missing; `pip install -r pipeline/requirements.txt`; downloads `hin`/`tel` traineddata into `pipeline/tessdata/` if absent and copies `eng.traineddata` from `$(brew --prefix)/share/tessdata/`; prints where HF models will be cached; prints `df -h` for the repo volume at the end. Then run it.
4. `.gitignore` add: `pipeline/.venv/`, `pipeline/tessdata/`, `pipeline/**/__pycache__/`. (`data/`, `.env*` and `ig_session.json` are already ignored; verify with `git check-ignore` before every commit that no DB, media, env or session file is staged.)
5. Check: `pipeline/.venv/bin/python -c "import requests, PIL, pytesseract, mlx_whisper, mlx_lm, Vision"` succeeds.

### Phase 2: database layer (`pipeline/reelvault/db.py`, `src/lib/db.ts`)
1. Move from `extract.py` into `db.py`: `DB_PATH`, `MEDIA_DIR` (honour `REEL_VAULT_DB` and `REEL_VAULT_MEDIA`), `connect()` (keep WAL + busy_timeout), `ensure_schema()` (today's `_ensure_columns` plus the new pieces), `queue(con, limit, retry_failed=False)`, `save(con, item_id, **fields)`, `stats(con)`.
2. New `items` columns (both sides): `keyframe_file text`, `duration_s real`, `music text`, `fetcher text`. Also make the Python migration add every column `db.ts` declares (`media_file, video, video_file, caption, transcript, ocr_text, entities default '[]', actions default '[]', content_status default 'pending', content_error`) and the index `items_content_status_idx`.
3. `quota_ledger` table exactly as spec §4 (Python side only).
4. `queue()`: statuses `pending` and `fetched` (plus `failed` when `retry_failed`), `fetched` first, then `pending`, then `failed`, each `added_at desc`.
5. `stats()`: counts per status, coverage of caption/transcript/ocr_text/summary, Apify credit used this cycle from the latest ledger row, free disk on the data volume.
6. In `src/lib/db.ts`, add only the four new `alter table` lines to the existing migration list, and the four fields to the `Item` type/row mapping if the type enumerates columns (keep it minimal; `npx tsc --noEmit` must pass).
7. Tests `pipeline/tests/test_db.py`: migration idempotent (run twice) on a temp DB created with the original 16-column `items` table; queue ordering and `retry_failed`; save; stats on empty and filled DBs.

### Phase 3: guardrails (`pipeline/reelvault/guardrails.py`)
Implement as pure functions over parsed JSON + one thin HTTP function each:
- `ALLOWED_LLM_MODELS = {"local": ["mlx-community/Qwen3-4B-Instruct-2507-4bit"], "groq": ["openai/gpt-oss-120b", "openai/gpt-oss-20b"]}`.
- `fetch_apify_limits(token) -> dict` (GET, 30 s timeout, raises `GuardrailError` with a clear message on 401/403).
- `assert_free_plan(limits)`: raise `GuardrailError("Apify account is on a paid plan (maxMonthlyUsageUsd=…). Use a free account with no card attached.")` if `data.limits.maxMonthlyUsageUsd > 5`.
- `CREDIT_STOP_USD = 4.50`, `PER_ITEM_USD = 0.003`, `PER_RUN_USD = 0.001`; `estimate_batch_usd(n)`; `credit_left(limits)`; `can_run_batch(limits, n) -> (bool, reason)` (False when `used + estimate > 4.50`, reason includes `monthlyUsageCycle.endAt`); `run_cap_usd(limits, n)` = `floor_to_cents(min(4.50 - used, estimate * 1.5))`, minimum 0.01, and `can_run_batch` must already have passed.
- `MIN_FREE_DISK_BYTES = 3 * 1024**3`; `check_disk(path) -> (ok, free_bytes)`.
- `with_backoff(fn, *, max_tries=3)`: on HTTP 429 (or `requests` response with status 429) sleep `Retry-After` seconds or 60, retry; after 3 raise `RateLimited`. Never switches provider or model.
- Tests `test_guardrails.py`: free-plan check at 5 and 5.01; credit boundary (used 4.45 + 15 items → refuse; used 4.40 + 15 → allow); run-cap rounding; disk check with a monkeypatched `shutil.disk_usage`; backoff with a fake clock (no real sleeping).

### Phase 4: fetchers
`pipeline/reelvault/fetch_apify.py`:
- `normalize_url(url) -> (kind, code, clean_url)` where kind ∈ {`reel`, `p`, `tv`}; `reels` → `reel`; returns None for non-Instagram URLs.
- `run_batch(urls, token, cap_usd) -> (items, run_summary)` per §3 Apify facts (start, poll, dataset); wrap HTTP in `with_backoff`.
- `map_item(item) -> FetchResult` (dataclass): `caption`, `video_url` (top-level `videoUrl`, else first child `videoUrl`), `image_urls` (`displayUrl`, then `childPosts[].displayUrl`, then `images[]`, deduped, max 10), `author` (`ownerUsername`), `duration_s` (`videoDuration` if ≥ 0), `music` (JSON string `{"song","artist","original"}` from `musicInfo`, or None), `taken_at` (`timestamp`), `error`.
- `fetch_batch(con, rows, token, *, dry_run)`: normalise, dedupe by shortcode, check guardrails (`can_run_batch`, `run_cap_usd`), run, append a `quota_ledger` row (`provider='apify'`, run id, items, `usageTotalUsd`, then a fresh limits read for `monthly_usage_after`), and apply results per row:
  - Found: `content_status='fetched'`, `fetcher='apify'`, `caption` (if non-empty), `video` = video_url, `author` if present, `duration_s`, `music`, `thumbnail` only if currently empty; title rule: if title is empty or starts with `Shared by ` and caption is non-empty, `title = caption.splitlines()[0][:120]`. Return the in-memory `FetchResult` (with `image_urls`) for Phase 6, since CDN links expire.
  - Not in results, or `error` set: `content_status='unavailable'`, `content_error` = `errorDescription`/`error`/`"not returned by Apify"` (≤ 300 chars).
  - Run failure (non-SUCCEEDED): leave rows untouched, record `content_error` on none, raise `FetchError` so the CLI stops cleanly.
- `pipeline/reelvault/fetch_sidecar.py`: move `shortcode()` and `fetch_caption()` from `extract.py` unchanged, plus `fetcher='sidecar'` in its save. Print a one-line ban-risk warning once per run.
- Tests `test_fetch_apify.py` with a fake HTTP session: URL normalisation (the real query-string example above), mapping of a reel item, a carousel with a video child, an image-only post, `musicInfo`, missing item → unavailable, title rule (placeholder replaced; real title kept), thumbnail only-if-empty, ledger row written, guardrail refusal makes no POST.

### Phase 5: offline media, OCR, speech
`pipeline/reelvault/media.py` (port from reference `study.py`/`media.py`): `download(url, dest)` (stream, `.part` then rename, User-Agent header, 120 s timeout, returns Path or None), `probe()`, `detect_cuts()` (threshold 0.30, min gap 0.2), `HOOK_TIMES = [0.0, 0.5, 1.0, 1.5, 2.0, 2.5]`, `pick_later_times()` (LATER_INTERVAL 3.0, MAX_LATER_FRAMES 10), `extract_frames_at()` (scale `min(896,iw)`), `dhash_bits()`, `text_changed()`, `dedupe_frames(cap=9)`, `pick_keyframe(times_paths) -> Path` (nearest t=1.0 s).
`pipeline/reelvault/ocr.py`: `apple_vision_ocr(path) -> str` (port `ocr_image` incl. `_OCR_LOCK` and `_SECRET_RE` redaction; returns "" if Vision is not importable); `tesseract_indic(path, tessdata_dir) -> str` keeping only lines with Devanagari (U+0900–U+097F) or Telugu (U+0C00–U+0C7F); `read_frame(path, tessdata_dir) -> str` (Vision + Indic lines; if Vision unavailable use Tesseract `eng+hin+tel` for everything); `merge_frame_texts(texts) -> str` (split lines, normalise for comparison, keep first occurrence in time order, join with `\n`, cap 2,000 chars). Lazy imports everywhere.
`pipeline/reelvault/transcribe.py`: `transcribe(video) -> str`. mlx-whisper with `REEL_VAULT_WHISPER_MODEL` (default `mlx-community/whisper-small-mlx`); if `mlx_whisper` cannot be imported, faster-whisper `small` int8 CPU (today's code). Keep rules: stripped text < 15 chars → ""; prefix `[<lang>] ` when language ≠ `en`. Load once, lazily.
Tests `test_media.py` (pick_later_times, dedupe_frames, text_changed, pick_keyframe; dhash on tiny PIL images), `test_ocr.py` (script filter, merge/dedupe/cap, redaction; Vision/Tesseract faked), `test_transcribe.py` (fake `mlx_whisper` module via `sys.modules`).

### Phase 6: orchestration + CLI
`pipeline/reelvault/process.py`: `process_item(con, row, fetched: FetchResult | None, *, keep_media, tessdata_dir)`:
1. Video path: download `video` URL (from `fetched` or the row) to `MEDIA_DIR/md5(id).mp4`, set `video_file`. Probe, cuts, hook+later times, extract frames into a temp dir, OCR each frame, dedupe (OCR first, so `text_changed` works), merge OCR, transcribe, keyframe → `MEDIA_DIR/<md5(id)>_k.jpg`.
2. Image path (no video): download up to 10 images to temp, OCR each, merge, keyframe = first image.
3. Save `transcript`, `ocr_text`, `keyframe_file`, `media_file` (only if empty) = keyframe filename, `duration_s` (if unset, from probe), `content_status='transcribed'`, `content_error` = None or a note if transcription alone failed (OCR still saved).
4. Download failed → `content_status='failed'`, `content_error='media download failed'`.
5. Unless `keep_media`, delete the mp4 and set `video_file = NULL` (keep `video`).
`pipeline/extract.py` becomes a thin CLI (spec §9): `--stats`, `--limit N`, `--run` (without it: dry run), `--fetcher apify|sidecar` (default apify), `--retry-failed`, `--keep-media`, `--batch 15`. Loads `.env.local` if present (simple KEY=VALUE parser; ignore comments; never print values) so `APIFY_TOKEN` works without a launcher. Flow: connect → ensure_schema → backup DB once (only with `--run`) → for apify: `assert_free_plan` once → loop batches: disk check → `can_run_batch` → fetch → `process_item` for each fetched row → commit. Items already `fetched` (from an earlier interrupted run) are processed using the row's `video` URL first; if that download fails, re-fetch them in the next batch. Keep SIGINT behaviour (finish current item, second Ctrl-C forces). Dry run prints: queued count, batches, estimated credit, credit used/left this cycle (if token present), free disk; with no token it explains how to add `APIFY_TOKEN=` to `.env.local` and exits 0. End of run prints `stats()` and the next step (start the LLM server, run `scripts/enrich-all.sh`).
Remove every Anthropic reference and the old `faster_whisper` import from `extract.py`.
`pipeline/start-extract.command` and `pipeline/run-extraction.command`: `cd` to repo root, `exec pipeline/.venv/bin/python pipeline/extract.py "$@"`. Stop sourcing `.env.local` in bash; the CLI reads it itself, and only uses the keys it needs.
Tests `test_process.py`: one video item and one image item end to end on a temp DB, with Apify, downloads, OCR, whisper faked; assert final columns, `transcribed`, video deleted, `media_file` set only when empty; a failed download → `failed`; dry run makes zero POSTs.

### Phase 7: local LLM for enrichment
1. Rewrite `src/lib/llm.ts` (keep exports `llmEnabled()` and `llmComplete(prompt, maxTokens)`):
   - `LLM_PROVIDER` = `local` (default) | `groq`. Base URL default `http://127.0.0.1:8090/v1` (local) / `https://api.groq.com/openai/v1` (groq); override `LLM_BASE_URL`. Model default `mlx-community/Qwen3-4B-Instruct-2507-4bit` / `openai/gpt-oss-120b`; override `LLM_MODEL`; reject anything not in the allow-list (same lists as guardrails) with a clear error.
   - `llmEnabled()`: local → true; groq → `!!GROQ_API_KEY`.
   - POST `${base}/chat/completions` with `{model, max_tokens, temperature: 0.2, messages:[{role:"user",content:prompt}]}`; Authorization header only for groq; 120 s timeout via `AbortSignal.timeout`; parse `choices[0].message.content`.
   - Update the `no GROQ_API_KEY configured` message in `src/app/api/enrich-pending/route.ts` to a provider-neutral one. In that route, also: when an item's title starts with `Shared by ` and the new summary is non-empty, set `title` to the summary's first sentence (≤ 90 chars). Touch nothing else there.
2. `src/lib/llm.test.ts` (vitest, mock `fetch`): defaults per provider, allow-list rejection, body shape, auth header only for groq, groq without key → disabled.
3. `pipeline/start-llm.command` (chmod +x): cd repo root; `exec pipeline/.venv/bin/mlx_lm.server --model mlx-community/Qwen3-4B-Instruct-2507-4bit --host 127.0.0.1 --port 8090`.
4. `scripts/enrich-all.sh` (chmod +x): loop `curl -s -X POST http://localhost:3210/api/enrich-pending` until `"enriched":0`; print running total; stop after 3 consecutive failures/non-200s; if `APP_PASSCODE` is set the route is behind the passcode gate, so send the `rv_auth` cookie value the app expects (read `src/middleware.ts` and `src/lib/passcode.ts` to do it correctly) or print a clear instruction.

### Phase 8: verify on this Mac (real, but still free)
Run all of these; fix what fails.
1. `pipeline/.venv/bin/python -m pytest pipeline/tests -q` and `npm test` and `npx tsc --noEmit`.
2. **Synthetic smoke test (no Instagram, no credit):** make a 6-second test video with burned-in text and real speech:
   `say -o /tmp/rv_say.aiff "Reel Vault smoke test. Try Whisper for transcription."` then
   `ffmpeg -y -f lavfi -i color=c=black:s=720x1280:d=6 -i /tmp/rv_say.aiff -vf "drawtext=text='TOP 3 AI TOOLS':fontcolor=white:fontsize=72:x=(w-text_w)/2:y=600" -shortest -c:v libx264 -c:a aac /tmp/rv_smoke.mp4`
   (if `drawtext` is unavailable in this ffmpeg build, render the text onto a PNG with PIL and loop it as the video). Write `pipeline/smoke_test.py` that runs media → OCR → transcribe on that file WITHOUT touching the DB and prints the OCR text, transcript, frame count and timings. Expect "TOP 3 AI TOOLS" in OCR and "smoke test" in the transcript. (First run downloads whisper-small, ~0.5 GB.)
3. **LLM smoke:** start `pipeline/start-llm.command` in the background (first run downloads ~2.3 GB), wait until `curl -s http://127.0.0.1:8090/v1/models` answers (poll up to 10 min), send one chat completion with `buildKnowledgePrompt`-style input, check that `parseKnowledgeResponse` gets a non-empty summary (write a tiny `scripts/llm-smoke.mjs` or a vitest marked `.skip` unless `LLM_SMOKE=1`). Kill the server afterwards.
4. **Dry run on the real DB:** `pipeline/.venv/bin/python pipeline/extract.py --stats` and `pipeline/.venv/bin/python pipeline/extract.py --limit 10` (dry run). This applies the migration to `data/reel-vault.db` (additive), which is expected.
5. **Only if `APIFY_TOKEN` is set** in `.env.local`: run `pipeline/.venv/bin/python pipeline/extract.py --limit 3 --run` (credit ≈ $0.01 of the free $5; guardrails must pass first). Then with `npm run dev` and the LLM server running in the background, run `scripts/enrich-all.sh` once, and check those 3 items have summaries. Stop both servers afterwards. If the token is missing, skip this step and say so in the report.
6. Record timings (per-item seconds for frames/OCR/whisper/LLM) and disk used by new downloads (`du -sh` of the HF cache and `pipeline/.venv`).

### Phase 9: docs + report
1. Update `docs/KNOWLEDGE-BASE.md` sections "One-time setup" and "1. Extract"/"2. Enrich" to the new flow (setup.sh, add `APIFY_TOKEN` to `.env.local` from a free Apify account with no card, dry run, `--limit 10 --run`, `start-llm.command`, `scripts/enrich-all.sh`). Keep its voice. Remove the claim that captions come from the sidecar by default and the 25-second pacing warning except under an "Optional: sidecar" note.
2. Update `CLAUDE.md`'s pipeline section and env-var table: remove `ANTHROPIC_API_KEY`/`REEL_VAULT_VISION_MODEL`/`REEL_VAULT_FRAMES`; add `APIFY_TOKEN`, `LLM_PROVIDER`, `LLM_BASE_URL`, `LLM_MODEL`, `KEEP_MEDIA`, `REEL_VAULT_WHISPER_MODEL` (new default).
3. Add `THIRD_PARTY_NOTICES.md`.
4. Write `docs/superpowers/plans/2026-10-06-phase1-report.md`: what was built (files), test results (counts), smoke results (OCR text, transcript, LLM summary), timings, disk used, whether the real 3-item run happened, open issues, and the exact commands the owner runs next:
   ```
   # add APIFY_TOKEN=... to .env.local (free account, no card)
   pipeline/.venv/bin/python pipeline/extract.py --limit 10          # dry run
   pipeline/.venv/bin/python pipeline/extract.py --limit 10 --run
   open pipeline/start-llm.command; npm run dev; scripts/enrich-all.sh
   pipeline/.venv/bin/python pipeline/extract.py --run               # the rest
   ```
5. Final commit `phase1: docs and report`. Print the report's path and a 10-line summary.

## 6. Definition of done

- All four test suites/commands in Phase 8.1 pass.
- `grep -rni "anthropic" pipeline/ src/lib/llm.ts` → nothing; `grep -rn "llama-3.3" src/` → nothing.
- Synthetic smoke shows the burned-in text and the spoken words; LLM smoke returns a parsed summary.
- Dry run on the real DB prints credit/disk numbers and makes no Apify run.
- No secrets in any file you wrote or in the console output.
- Everything committed on `phase1/zero-spend-pipeline`, nothing pushed.

=====
