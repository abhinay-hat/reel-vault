# Phase 1 work packets: zero-spend offline pipeline

**Spec:** `docs/superpowers/specs/2026-10-06-zero-spend-offline-pipeline-design.md` (read it first; section numbers below point into it)
**Workflow:** Claude wrote the spec. Cursor CLI and Antigravity CLI write the code, one lane each, in parallel. Claude reviews each lane's diff and runs the tests, then sends the next round of fixes.

## 0. Before starting (once)

The package scaffold (`pipeline/reelvault/__init__.py`, `pipeline/tests/conftest.py`) and these two docs are already in place. The working tree also has your own uncommitted changes. Save everything, then give each lane its own worktree so agents never edit the same checkout:

```bash
cd ~/Projects/Experimental/reel-vault
git add -A && git commit -m "wip: snapshot before phase 1"
git worktree add ../rv-lane-a -b phase1/lane-a-fetch
git worktree add ../rv-lane-b -b phase1/lane-b-media
git worktree add ../rv-lane-c -b phase1/lane-c-llm
```

Run each lane's agent from inside its worktree, giving it the prompt below as its task. Lanes A, B and C run at the same time. Lane D starts after A and B are merged.

## Lane plan

| Lane | Agent | Owns (only these files) | Depends on |
|---|---|---|---|
| A: data + fetch + guardrails | Cursor CLI | `pipeline/reelvault/db.py`, `guardrails.py`, `fetch_apify.py`, `fetch_sidecar.py`, `pipeline/tests/test_db.py`, `test_guardrails.py`, `test_fetch_apify.py`, `src/lib/db.ts` (column list only) | nothing |
| B: media + OCR + speech | Antigravity CLI | `pipeline/reelvault/media.py`, `ocr.py`, `transcribe.py`, `pipeline/tests/test_media.py`, `test_ocr.py`, `test_transcribe.py`, `THIRD_PARTY_NOTICES.md` | nothing |
| C: local LLM for enrichment | Cursor CLI (second terminal) | `src/lib/llm.ts`, `src/lib/llm.test.ts`, `pipeline/start-llm.command`, `scripts/enrich-all.sh` | nothing |
| D: wire-up + setup | Cursor CLI | `pipeline/reelvault/process.py`, `pipeline/extract.py`, `pipeline/setup.sh`, `pipeline/requirements.txt`, `pipeline/start-extract.command`, `pipeline/run-extraction.command`, `.gitignore`, `pipeline/tests/test_process.py` | A and B merged |

If an agent believes it must touch a file outside its list, it stops and says so in its report instead of editing.

## Shared rules for every lane (paste with each prompt)

```
Shared rules (from the spec §1):
- Never add a paid API call. Remove nothing you don't own, but never call Anthropic, paid Apify add-ons, or any LLM model outside the allow-list in spec §6.
- Never log in to Instagram in the default path.
- Keep statuses exactly: pending, fetched, transcribed, enriched, failed, unavailable.
- Migrations are additive and idempotent.
- Code ported from github.com/jakeb144/reel-watcher (MIT) keeps a header comment naming the source file.
- Tests use no network and no real models (fake them). Run them before you finish.
- Python ≥ 3.10, standard library + requests + pillow only, unless the spec lists the package.
- Finish with a short report: files changed, how you tested, anything you were unsure about.
```

## Lane A prompt (Cursor CLI)

```
Read docs/superpowers/specs/2026-10-06-zero-spend-offline-pipeline-design.md, then pipeline/extract.py and src/lib/db.ts.

Build the data, fetch and guardrail layer of the new pipeline package (spec §3, §4, §5 step 1, §6):

1. pipeline/reelvault/db.py: move connect(), _ensure_columns(), queue(), save() and stats() out of pipeline/extract.py (copy; Lane D deletes the originals). Add the new columns from §4 (keyframe_file, duration_s, music, fetcher) and the quota_ledger table. queue() gains retry_failed: bool (default False excludes 'failed').
2. src/lib/db.ts: add the same four columns to the migration list. Touch nothing else in that file.
3. pipeline/reelvault/guardrails.py: free-plan check, credit meter, per-run cap, model allow-list, disk check, 429 backoff helper, exactly as the §6 table says. Pure functions take the parsed limits JSON so they are testable; one small function does the HTTP GET.
4. pipeline/reelvault/fetch_apify.py: run apify~instagram-scraper on a batch of up to 15 URLs with the exact input in §6, poll the run, read the dataset, and map each item onto vault fields as §5 step 1 says (title rule, thumbnail only if empty, author, caption, video URL, duration_s, music, fetcher='apify'). Missing or errored items → unavailable with the reason. Write a quota_ledger row per run. Return per-item results; do not download videos (Lane B/D do that).
5. pipeline/reelvault/fetch_sidecar.py: move fetch_caption() and shortcode() from extract.py unchanged, plus set fetcher='sidecar'.
6. Tests: pipeline/tests/test_db.py, test_guardrails.py, test_fetch_apify.py per spec §10 (fake the HTTP layer).

Done when: pytest pipeline/tests passes; no network in tests; APIFY_TOKEN only read from the environment and never printed.
```

## Lane B prompt (Antigravity CLI)

```
Read docs/superpowers/specs/2026-10-06-zero-spend-offline-pipeline-design.md (§5 steps 2–6, §10). Reference code: https://github.com/jakeb144/reel-watcher, files src/reel_watcher/study.py and src/reel_watcher/media.py (MIT).

Build the offline media layer (pure functions where possible, each takes paths and returns data; no database access):

1. pipeline/reelvault/media.py: download_video(url, item_id, media_dir) (same behaviour as pipeline/extract.py's download_video), probe(), detect_cuts(), hook + later frame times (HOOK_TIMES, pick_later_times), extract_frames_at(), dhash_bits(), text_changed(), dedupe_frames(cap=9), and pick_keyframe(frames) → the unique frame nearest t=1.0s.
2. pipeline/reelvault/ocr.py: apple_vision_ocr(path) (port ocr_image incl. _SECRET_RE redaction; returns "" when pyobjc Vision is unavailable), tesseract_indic(path, tessdata_dir) using -l hin+tel and keeping only lines with Devanagari (U+0900–U+097F) or Telugu (U+0C00–U+0C7F) characters, read_frame(path) combining both (Tesseract eng+hin+tel when Vision is unavailable), and merge_frame_texts(list) → deduped lines in time order, capped at 2000 chars.
3. pipeline/reelvault/transcribe.py: transcribe(video) using mlx-whisper with REEL_VAULT_WHISPER_MODEL (default mlx-community/whisper-small-mlx), falling back to faster-whisper small int8 CPU when mlx_whisper can't be imported. Keep the existing rules from pipeline/extract.py: under 15 chars → "", prefix "[lang] " when language != en. Load the model lazily, once.
4. THIRD_PARTY_NOTICES.md with reel-watcher's MIT licence text and copyright line.
5. Tests: pipeline/tests/test_media.py, test_ocr.py, test_transcribe.py per spec §10. Fake Vision, Tesseract and whisper; tiny generated images are fine for dhash.

Done when: pytest pipeline/tests passes on a machine without mlx or pyobjc (imports must be lazy and guarded).
```

## Lane C prompt (Cursor CLI, second terminal)

```
Read docs/superpowers/specs/2026-10-06-zero-spend-offline-pipeline-design.md §6 (allow-list) and §7, then src/lib/llm.ts and src/app/api/enrich-pending/route.ts.

1. Rewrite src/lib/llm.ts as the provider switch in §7 (LLM_PROVIDER local|groq, LLM_BASE_URL, LLM_MODEL, GROQ_API_KEY), keeping the exported names llmEnabled() and llmComplete(prompt, maxTokens) so no caller changes. Enforce the allow-list: throw a clear error for any other model. temperature 0.2.
2. src/lib/llm.test.ts (vitest): defaults per provider, allow-list rejection, request body shape, groq without key → disabled. Mock fetch.
3. pipeline/start-llm.command: double-clickable, cd to repo root, exec pipeline/.venv/bin/python -m mlx_lm.server --model mlx-community/Qwen3-4B-Instruct-2507-4bit --host 127.0.0.1 --port 8090. chmod +x.
4. scripts/enrich-all.sh: loop POST http://localhost:3210/api/enrich-pending until "enriched":0, print running total, stop after 3 consecutive errors or non-200s. chmod +x.

Do not edit ai.ts, the enrich routes or db.ts. Done when: npm test passes.
```

## Lane D prompt (Cursor CLI, after A and B are merged)

```
Read docs/superpowers/specs/2026-10-06-zero-spend-offline-pipeline-design.md (§3, §5, §8, §9, §11) and the merged pipeline/reelvault package.

1. pipeline/reelvault/process.py: per-item orchestration for §5 steps 2–8 using media, ocr and transcribe; partial-failure policy as §5 says; delete the video and clear video_file unless keep_media.
2. pipeline/extract.py: becomes a thin CLI per §9 (dry run by default, --run, --limit, --fetcher apify|sidecar, --retry-failed, --keep-media, --batch, --stats). Batch loop: guardrails (free-plan check once; credit meter and disk check before each batch) → fetch → process each item → commit. Remove the Anthropic read_frames path and its env vars entirely. Keep SIGINT handling.
3. pipeline/setup.sh, pipeline/requirements.txt, .gitignore additions, pipeline/start-extract.command and pipeline/run-extraction.command per §8 (both launchers use the venv). setup.sh must be idempotent and print free disk at the end.
4. pipeline/tests/test_process.py: one item end to end on a temp DB with every external piece faked (Apify, download, OCR, whisper).
5. Update docs/KNOWLEDGE-BASE.md "One-time setup" and "1. Extract" to the new commands (keep its tone).

Done when: pytest pipeline/tests and npm test pass; extract.py --limit 3 (dry run) works without APIFY_TOKEN by explaining what is missing.
```

## Review loop (Claude)

After each lane reports, tell Claude "lane X done". Claude will:

1. Read the diff in that worktree against the spec, file ownership and hard rules.
2. Run the Python tests and `npm test`.
3. Grep for anything that could spend money (`anthropic`, `api.groq.com` outside llm.ts, Apify add-on fields, unknown model ids).
4. Send back either "merge" or a numbered fix list for the same agent.

Merge order: C, A, B (any order among these), then D. Then run the acceptance steps in spec §11, starting with 10 reels.
