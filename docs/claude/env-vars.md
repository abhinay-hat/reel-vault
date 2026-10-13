# Environment variables

| Var | Effect |
|-----|--------|
| `APP_PASSCODE` | Enables the passcode gate (unset = open app) |
| `SHARE_TOKEN` | Enables `/api/share` (unset = 503) |
| `APIFY_TOKEN` | Enables Apify Free fetcher for `pipeline/extract.py --run` |
| `LLM_PROVIDER` | `local` (default) or `groq` |
| `LLM_BASE_URL` | OpenAI-compatible base (default local `:8090/v1` or Groq) |
| `LLM_MODEL` | Must be on the allow-list in `src/lib/llm.ts` / guardrails |
| `GROQ_API_KEY` | Required only when `LLM_PROVIDER=groq` |
| `KEEP_MEDIA` | Keep downloaded mp4s under `data/media/` |
| `REEL_VAULT_WHISPER_MODEL` | Whisper weights (default `mlx-community/whisper-small-mlx`) |
| `REEL_VAULT_DB` | SQLite file path override |
| `REEL_VAULT_MEDIA` | Media directory override |
| `IG_BRIDGE_URL` | Sidecar base URL (default `http://127.0.0.1:8765`) |
| `IG_MEDIA_MIN_INTERVAL_SECONDS` | Sidecar-only pacing (default 25) — ban guard |
| `IG_SESSION_FILE`, `IG_MIN_GATHER_INTERVAL_HOURS`, `IG_COOLDOWN_HOURS` | Sidecar-side (Python) config |
