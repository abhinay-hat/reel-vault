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
| `pytest pipeline/tests` | **33 passed** |
| `npm test` (vitest) | **37 passed** (7 files) |
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
| Free on data volume after smokes | ~13 GB |

## Open issues

1. Free disk is tight (~13 GB). Guardrail stops below 3 GB; full 396-item run + models is OK if videos are deleted after each item (default).
2. This Mac's ffmpeg briefly broke on an x265 soname bump; fixed via symlink + `brew reinstall ffmpeg`.
3. ffmpeg build has no `drawtext`; smoke video used PIL + Arial Bold.
4. Optional: attach a free Apify account (no card) and run the 3-item path below.

## Owner next commands

```bash
# add APIFY_TOKEN=... to .env.local (free account, no card)
pipeline/.venv/bin/python pipeline/extract.py --limit 10          # dry run
pipeline/.venv/bin/python pipeline/extract.py --limit 10 --run
open pipeline/start-llm.command; npm run dev; scripts/enrich-all.sh
pipeline/.venv/bin/python pipeline/extract.py --run               # the rest
```
