---
paths:
  - "pipeline/**"
  - "scripts/**"
---

### Content extraction — `pipeline/extract.py` + `pipeline/reelvault/`

A DM-shared reel arrives as a bare URL: Instagram's share payload has no caption, so those items land titled `Shared by <user id>` with nothing inside. Until this pipeline runs, the vault holds pointers, not knowledge.

Default path (₹0): Apify Free actor `apify~instagram-scraper` fetches caption + media URL; then local ffmpeg keyframes, Apple Vision + Tesseract (hin/tel), and mlx-whisper fill `transcript` / `ocr_text`. `content_status` tracks pipeline position (`pending` → `fetched` → `transcribed` → `enriched`). Sidecar fetch is opt-in only (`--fetcher sidecar`). See `docs/KNOWLEDGE-BASE.md`. One-time install: `./pipeline/setup.sh`.
