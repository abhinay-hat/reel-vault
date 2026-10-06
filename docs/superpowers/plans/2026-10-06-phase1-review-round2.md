# Phase 1 review, round 2: two enrichment edge cases

**Reviewer:** Claude, 2026-10-06. Reviewed `afdfdd8`. `pytest pipeline/tests` re-run independently: 43 passed. Round 1 items 1–9 verified in the diff: crash isolation, re-fetch of interrupted rows, retryable Apify misses, fail-closed plan check, OCR pipeline order and filters, Whisper filters, timing line, HMAC cookie.

Two gaps remain, both in enrichment. Extraction is ready for the first real 10-reel run now; these fixes only need to land before `scripts/enrich-all.sh` runs on the full vault.

Paste everything between the `=====` lines into Cursor on `phase1/zero-spend-pipeline`.

=====

Continue on branch `phase1/zero-spend-pipeline`. Same HARD RULES as before. Two fixes, each with tests, each committed as `phase1-fix2: <n> <name>`. Work without stopping.

## 1. Text-less items block the enrichment queue
`ENRICH_ELIGIBLE` in `src/lib/db.ts` admits every `content_status = 'transcribed'` row, even one with no caption, transcript or on-screen text (music-only reels, image posts without text). The route then `continue`s past it without touching `enrich_attempts`, so it stays first in the queue (attempts 0, newest). Five such rows → every call returns `enriched: 0` → `enrich-all.sh` stops after two calls and the rest of the vault is never enriched.
- Change `ENRICH_ELIGIBLE` so every branch requires at least one non-empty text field: `(content_status = 'transcribed' or (content_status != 'unavailable' and (summary is null or summary = ''))) and (coalesce(caption,'') != '' or coalesce(transcript,'') != '' or coalesce(ocr_text,'') != '') and coalesce(enrich_attempts,0) < 3`.
- Remove the now-unreachable `continue` in the route, or keep it as a defensive guard that also increments `enrich_attempts`.
- `pipeline/extract.py --stats`: add a line `no text extracted: N` (status `transcribed`, all three text fields empty) so these items are visible.
- Vitest: a text-less `transcribed` row is not returned by `listItemsNeedingEnrichment` and not counted by `countItemsNeedingEnrichment`; a row with only `ocr_text` is.

## 2. `enrich-all.sh` stops before failing items drop out
The stall rule stops after two calls with `enriched == 0`, even when those calls are recording failures. Each failure increments `enrich_attempts`, so a third call would have moved past them.
- Stop on stall only when two consecutive calls have `enriched == 0` **and** `failed == 0`. Keep the 3-HTTP-failure stop and the `remaining == 0` exit.
- Add a hard ceiling: stop after `ceil(remaining_at_start / limit) * 4 + 10` calls, so it always ends.
- Print at the end: total enriched, total failed, remaining.

Then run `pipeline/.venv/bin/python -m pytest pipeline/tests -q`, `npm test`, `npx tsc --noEmit`. Append a "Round 2 fixes" section to `docs/superpowers/plans/2026-10-06-phase1-report.md` with test counts. Commit `phase1-fix2: report`.

=====
