# Phase 1 decisions

- credit boundary test: used 4.46 (not 4.45) + 15 items refuses — exact math `n×0.003+0.001` makes 4.45+0.046=4.496 ≤ 4.50 still allow.
- run-extraction.command simplified to thin venv launcher (sidecar auto-start removed; Apify is default; sidecar stays `--fetcher sidecar`).
- enrich-all.sh / login: `rv_auth` cookie is HMAC-SHA256(APP_PASSCODE, "rv_auth:v1") hex (was literal `ok`; that bypassed the gate).
- setup.sh: uv venv has no pip — install via `uv pip install --python pipeline/.venv/bin/python`.
- ffmpeg dyld: Homebrew x265 bumped to `.217` while ffmpeg still linked `.215` — temporary `libx265.215.dylib` → `.217` symlink unblocked smoke; brew reinstall ffmpeg afterwards.
- smoke video: ffmpeg `drawtext` missing in this build — PIL + Arial Bold burned-in text instead.

## Round 1 fixes
- fix 2 (resume re-fetch): landed in `phase1-fix: 1` commit with extract batching `already + pending` and `caption_only_ok` — not split because same edit pass.
- fix 8 (per-item timing): `_print_timing` in process.py, same commit as fix 1.
- fix 1 `_safe_process`: KeyboardInterrupt re-raised; other exceptions → failed + delete mp4.
