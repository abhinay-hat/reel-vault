# Phase 1 report — zero-spend offline pipeline

Branch: `phase1/zero-spend-pipeline` (not pushed).

## What was built

| Area | Files |
|---|---|
| Setup | `pipeline/setup.sh`, `pipeline/requirements.txt`, `.gitignore` |
| DB | `pipeline/reelvault/db.py`, `src/lib/db.ts` (+ `keyframe_file`, `duration_s`, `music`, `fetcher`) |
| Guardrails | `pipeline/reelvault/guardrails.py` |
| Fetchers | `pipeline/reelvault/fetch_apify.py`, `fetch_sidecar.py` |
| Media / OCR / STT | `pipeline/reelvault/media.py`, `ocr.py`, `transcribe.py` |
| Orchestration | `pipeline/reelvault/process.py`, thin `pipeline/extract.py` |
| Launchers | `start-extract.command`, `run-extraction.command`, `start-llm.command` |
| Enrichment | `src/lib/llm.ts`, `src/lib/llm.test.ts`, `scripts/enrich-all.sh`, enrich-pending title rule |
| Smokes / notices | `pipeline/smoke_test.py`, `scripts/llm-smoke.mjs`, `THIRD_PARTY_NOTICES.md` |
| Docs | `docs/KNOWLEDGE-BASE.md`, `CLAUDE.md`, decisions + this report |

Anthropic vision path removed from `pipeline/`. Default fetcher is Apify Free; sidecar is `--fetcher sidecar` only.

## Test results

| Suite | Result |
|---|---|
| `pytest pipeline/tests` | **33 passed** (Phase 1); **43** after Round 1 |
| `npm test` (vitest) | **37 passed** (Phase 1); **42** after Round 1 |
| `npx tsc --noEmit` | **clean** |
| `grep -rni anthropic pipeline/` (excl. `.venv`) | nothing |
| `grep -rn llama-3.3 src/` | nothing |

## Smoke results

### Media / OCR / Whisper (`pipeline/smoke_test.py` on `/tmp/rv_smoke.mp4`)

- Frames: 6 (~1.7 s extract)
- OCR (~40 s): `TOP 3 AI TOOLS` (+ minor Indic Tesseract noise line)
- Transcript (~4.3 s after model cached): `Real Vault Smoke Test, Try Whisper for Transcription.`
- `ocr_ok=True` `transcript_ok=True`
- First whisper download ~0.5 GB / ~110 s

### Local LLM (`mlx_lm.server` :8090, Qwen3-4B)

- `/v1/models` answered after ~2.3 GB download
- Chat completion ~26.6 s
- Parsed summary: *A video highlights the top 3 AI tools recommended for students in 2026, with a focus on Whisper for transcription capabilities.*

## Dry run on real DB

```
items: 396
  pending      396
coverage: caption=0 transcript=0 ocr=0 summary=0
free disk: ~13 GB
queued: 10  batches≈1  est credit≈$0.0310
No APIFY_TOKEN — explained how to add it; exit 0; no actor POST
```

Additive migration applied to `data/reel-vault.db` (expected). DB backup skipped (only created on `--run`).

## Real 3-item Apify run

**Skipped** — `APIFY_TOKEN` not present in `.env.local`.

## Disk used

| Path | Size |
|---|---|
| `pipeline/.venv` | ~1.2 GB |
| `~/.cache/huggingface` | ~2.6 GB (whisper-small + Qwen3-4B) |
| Free on data volume after smokes | ~8 GB (was ~13 GB before Qwen download) |

## Open issues

1. Free disk is tight (~13 GB). Guardrail stops below 3 GB; full 396-item run + models is OK if videos are deleted after each item (default).
2. This Mac's ffmpeg briefly broke on an x265 soname bump; fixed via symlink + `brew reinstall ffmpeg`.
3. ffmpeg build has no `drawtext`; smoke video used PIL + Arial Bold.
4. Optional: attach a free Apify account (no card) and run the 3-item path below.

## Round 1 fixes (2026-10-06)

Reviewed at `72d7c44`; fixes on branch tip after `phase1-fix:*` commits.

| # | Change |
|---|---|
| 1 | `_safe_process`: exceptions → `failed` + delete mp4; `KeyboardInterrupt` still stops |
| 2 | Interrupted `fetched` rows re-batched with Apify; no caption-only `transcribed` without `FetchResult` |
| 3 | Apify miss → `failed` (`apify: not returned`); permanent phrases → `unavailable`; print counts |
| 4 | `enrich_attempts` + exclude ≥3; route `?limit=` (default 5); retry once; `{enriched,failed,remaining}`; enrich-all stalls after 2 no-progress loops |
| 5 | `assert_free_plan` fail-closed if `maxMonthlyUsageUsd` missing |
| 6 | Vision lines + dedupe then Indic-only Tesseract on ≤9 uniques; conf≥70 + 60% Indic filter |
| 7 | Whisper: `condition_on_previous_text=False`, drop bad segments, collapse 3× repeats |
| 8 | Per-item timing line (`frames`/`vision`/`tesseract`/`whisper`) |
| 9 | `rv_auth` = HMAC-SHA256(passcode, `rv_auth:v1`); literal `ok` rejected — **re-login once** |

### Round 1 test counts

| Suite | Result |
|---|---|
| pytest | **43 passed** |
| vitest | **42 passed** (10 files) |
| tsc | clean |

### Round 1 smoke timings (synthetic `/tmp/rv_smoke.mp4`)

| Step | Time |
|---|---|
| frames | 0.6 s (6 frames) |
| Vision | 1.1 s total — per-frame ≈ `[0.8, 0.05×5]` |
| Tesseract | 0.4 s on **1** unique frame (was ~40 s Vision+Indic on all 6) |
| Whisper | 3.8 s |
| **Item total** | **~5.9 s** |
| OCR | `TOP 3 AI TOOLS` (no Indic noise line) |
| LLM | summary non-empty in ~7 s (warm server) |

### Estimated hours for 386 items

- Synthetic floor ≈ 6 s/item → ~0.6 h compute only (unrealistic for real reels).
- Realistic with longer clips + Apify: **~30–60 s/item** → **about 3–6.5 hours** wall clock for extract, then enrich at ~7–27 s/item for local Qwen (~1–3 h for 386).
- OCR no longer dominates (Vision-once + Indic on uniques).

## Round 2 fixes (2026-10-06)

| # | Change |
|---|---|
| 1 | `ENRICH_ELIGIBLE` requires caption/transcript/ocr; text-less `transcribed` excluded; `--stats` prints `no text extracted: N`; defensive route bump |
| 2 | `enrich-all.sh` stalls only when `enriched==0` **and** `failed==0`; call ceiling `ceil(start/limit)*4+10`; end totals printed |

### Round 2 test counts

| Suite | Result |
|---|---|
| pytest | **44 passed** |
| vitest | **43 passed** (10 files) |
| tsc | clean |

Extraction ready for first real 10-reel run. Land these before full-vault `scripts/enrich-all.sh`.

## Owner next commands

```bash
# add APIFY_TOKEN=... to .env.local (free account, no card)
# if APP_PASSCODE is set: log in once in the browser (cookie format changed)
pipeline/.venv/bin/python pipeline/extract.py --limit 10          # dry run
pipeline/.venv/bin/python pipeline/extract.py --limit 10 --run
open pipeline/start-llm.command; npm run dev; scripts/enrich-all.sh
pipeline/.venv/bin/python pipeline/extract.py --run               # the rest
```
