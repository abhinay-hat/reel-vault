# Phase 1 review, round 1: fixes before the real run

**Reviewer:** Claude, 2026-10-06. Reviewed branch `phase1/zero-spend-pipeline` at `72d7c44`; `pytest pipeline/tests` re-run independently: 33 passed.
**Verdict:** good foundation. The guardrails, Apify mapping, allow-list and removal of the paid path are correct. Fix the items below before the full 386-item run. Items 1–4 would lose data or stall an unattended run.

How to use: paste everything between the `=====` lines into Cursor from the repo root, on the same branch.

=====

You are continuing Phase 1 of Reel Vault on branch `phase1/zero-spend-pipeline`. Read `docs/superpowers/specs/2026-10-06-zero-spend-offline-pipeline-design.md` and `docs/superpowers/plans/2026-10-06-phase1-report.md` first. Work autonomously through every item below without stopping; record any judgement call in `docs/superpowers/plans/2026-10-06-phase1-decisions.md`. All HARD RULES from the original prompt still apply (no paid calls, no Instagram login by default, fixed status names, additive migrations, no secrets printed, tests offline). Add or update tests for every item. Commit after each item as `phase1-fix: <n> <short name>`. Never push.

## 1. One bad item must not crash the run (high)
`_run_apify` and `_run_sidecar` in `pipeline/extract.py` call `process_item` with no exception handling. An ffmpeg, Vision, Tesseract or whisper exception on one reel kills the whole unattended run and leaves its video on disk.
- Wrap each `process_item` call: on any exception, `save(content_status='failed', content_error='process: <ExceptionType>: <msg>'[:300])`, delete `MEDIA_DIR/<md5(id)>.mp4` if present unless keep_media, clear `video_file`, print one line, continue with the next item.
- `KeyboardInterrupt` must still stop the run (don't swallow it).
- Test: a faked `read_frame` that raises → item `failed`, video deleted, next item still processed.

## 2. Resumed `fetched` rows lose content (high)
Rows left `fetched` by an interrupted run are processed with `fetched=None`. Then (a) image posts have no stored image URLs, so they fall into "no media", become `transcribed` with no OCR, and are never looked at again; (b) reel video URLs are signed and expire within hours, so the download fails.
- In `_run_apify`, stop processing `already` rows from stale data: put them back into the Apify batches together with `pending` (the re-fetch costs ~$0.003 each). Keep `fetched` rows first in the batch order.
- In `process_item`, when `fetched is None` and the row has no `video`, do not mark it `transcribed`; for the sidecar path keep today's behaviour (the sidecar is the source of truth there).
- Test: interrupted image post → re-fetched in the next run and gets `ocr_text`.

## 3. "Not returned by Apify" is not permanent (high)
`fetch_batch` marks rows Apify didn't return, and every errored item, as `unavailable`, which the queue never retries. Missing results are often transient (Apify blocks, rate limits).
- Not returned at all → `failed` with `content_error='apify: not returned'` (retried with `--retry-failed`).
- Item with `error`/`errorDescription`: `unavailable` only when the text (case-insensitive) contains one of `not found`, `doesn't exist`, `does not exist`, `removed`, `deleted`, `private`, `restricted`, `unavailable`; everything else → `failed` with `content_error='apify: <message>'`.
- After a run, print counts: fetched / failed / unavailable.
- Tests for each branch.

## 4. Enrichment can stall forever (high)
`listItemsNeedingEnrichment(20)` has no ordering or exclusion, so an item whose LLM reply never parses is returned again every call. Once 20 such items accumulate, `/api/enrich-pending` returns `enriched: 0`, `scripts/enrich-all.sh` stops, and the rest of the vault never gets summaries.
- Add column `enrich_attempts integer not null default 0` (both `src/lib/db.ts` and `pipeline/reelvault/db.py`).
- In the route: on an empty summary or LLM error, increment `enrich_attempts` and set `content_error='enrich: <reason>'[:300]`; on success reset `content_error`.
- `listItemsNeedingEnrichment(limit)`: exclude `enrich_attempts >= 3`; order by `enrich_attempts asc, added_at desc`.
- Route: accept `?limit=` (default 5, max 20) so progress shows sooner with the slow local model (~27 s per item). Return `{enriched, failed, remaining}` where `remaining` counts items still eligible.
- `scripts/enrich-all.sh`: loop while `remaining > 0`; stop when two consecutive calls make no progress (`enriched == 0`) or after 3 HTTP failures; print `enriched / failed / remaining` each loop. Use `curl --max-time 900`.
- Retry once inside the route if the first reply doesn't parse, with "Respond with ONLY the JSON object." appended. Do not change `parseKnowledgeResponse`.
- Vitest for the selection/exclusion SQL and the route's counters (mock `llmComplete`).

## 5. Free-plan check must fail closed (medium)
`assert_free_plan` returns silently when `maxMonthlyUsageUsd` is missing. A response we can't read must stop the run, not allow it. Raise `GuardrailError("Could not read Apify plan limits; refusing to run.")`. Update the test.

## 6. OCR quality and speed (medium)
The smoke test took ~40 s of OCR for 6 frames, and a stray Indic "noise" line appeared on an English-only frame. With up to 16 frames per reel this would add ~1.5 minutes per item, or about 10 hours for the backlog, and pollute search.
- `apple_vision_ocr`: return one line per text observation (join with `\n`), normalise whitespace per line, redact, cap 1,000 chars per frame. Keep the sort order (top to bottom).
- Order of work per video: run Vision on every sampled frame → `dedupe_frames` using Vision text → run Tesseract Indic **only on the unique frames** (≤ 9).
- `tesseract_indic`: use `pytesseract.image_to_data(..., output_type=Output.DICT)`; keep words with `conf >= 70`; rebuild lines by `(block_num, par_num, line_num)`; keep a line only if it has ≥ 3 Devanagari/Telugu letters and those make up ≥ 60% of its letters. Upscale frames narrower than 720 px by 2× before Tesseract.
- Measure: extend `pipeline/smoke_test.py` to print seconds per frame for Vision and for Tesseract separately, and the total per item. Put the numbers in the report.
- Tests: noise line rejected (mixed-script garbage), real Hindi line kept (fake `image_to_data` output), Tesseract called only for unique frames.

## 7. Whisper hallucinations on music-only reels (medium)
Many reels are music only, and Whisper invents lyrics or repeats a phrase ("Thank you. Thank you.").
- Call `mlx_whisper.transcribe(..., condition_on_previous_text=False)` (faster-whisper: same flag plus `vad_filter=True`).
- Drop segments with `no_speech_prob > 0.6` and `avg_logprob < -1.0`; rebuild text from the kept segments.
- Collapse any sentence repeated 3+ times in a row to one.
- Keep the existing under-15-chars and `[lang]` rules.
- Tests with fake segment lists.

## 8. Per-item timing (low)
Print a compact line per processed item: `✓ <id8> video 38s (frames 2s, vision 6s, tesseract 9s, whisper 5s) ocr 312ch transcript 940ch`. Store nothing new in the DB. This tells us whether the full run is overnight or hours.

## 9. Verify and report
- Run `pipeline/.venv/bin/python -m pytest pipeline/tests -q`, `npm test`, `npx tsc --noEmit`, and the two smokes again (`pipeline/smoke_test.py`, LLM smoke). Then the dry run on the real DB.
- Update `docs/superpowers/plans/2026-10-06-phase1-report.md` with a "Round 1 fixes" section: what changed per item, test counts, new smoke timings per frame and per item, and an estimated total hours for 386 items.
- Final commit `phase1-fix: report`. Print a 10-line summary.

=====
