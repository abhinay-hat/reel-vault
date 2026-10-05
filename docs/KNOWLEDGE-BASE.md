# Making the vault readable

The vault was holding 396 links and nothing else. Every DM-shared reel arrived
titled `Shared by <user id>` with no caption, no transcript, and no summary,
because Instagram's DM-share payload carries only a URL. Search had nothing to
search.

This is the path from links to a knowledge base you can ask questions of.

```
  reel URL                                    (what you had)
     |
     |  1. pipeline/extract.py
     |     caption + media URL  <- Apify Free (no card)
     |     transcript           <- mlx-whisper, local, free
     |     ocr_text             <- Apple Vision + Tesseract (hin/tel)
     v
  raw text on this machine
     |
     |  2. POST /api/enrich-pending  (local Qwen3-4B via mlx_lm.server)
     |     summary, category, tags
     |     entities  <- the films, portals, models, universities by name
     |     actions   <- what the reel asks you to do
     v
  structured knowledge
     |
     |  3. mcp/reel-vault-mcp.mjs
     v
  askable from any Claude conversation      (what you have now)
```

## One-time setup

```bash
# installs ffmpeg, tesseract, Python 3.12 venv, mlx packages, hin/tel tessdata
./pipeline/setup.sh

# free Apify account with no card attached — paste the token once
# APIFY_TOKEN=apify_api_...   →  .env.local
```

Enrichment defaults to a local LLM (`LLM_PROVIDER=local`). Optional free Groq
models are allow-listed; set `LLM_PROVIDER=groq` and `GROQ_API_KEY` only if you
want that path.

## 1. Extract

```bash
pipeline/.venv/bin/python pipeline/extract.py --stats
pipeline/.venv/bin/python pipeline/extract.py --limit 10          # dry run
pipeline/.venv/bin/python pipeline/extract.py --limit 10 --run    # ~$0.03 of free credit
pipeline/.venv/bin/python pipeline/extract.py --run               # the rest
```

Or double-click `pipeline/start-extract.command`.

Dry run (no `--run`) prints queue size, estimated credit, and free disk — it
never starts an Apify actor. CDN media URLs expire within hours, so a real run
downloads immediately, OCRs, transcribes, then deletes the mp4 unless
`--keep-media` / `KEEP_MEDIA=1`.

Ctrl-C is safe. Every item commits as it finishes. Credit stops cleanly at
$4.50 of the free $5 monthly cycle so the account cannot tip into billing.

### Optional: sidecar

`--fetcher sidecar` still exists for the private-API path. It prints a ban-risk
warning and is never the default. If you use it, keep
`IG_MEDIA_MIN_INTERVAL_SECONDS` (default 25) as a ban guard — not a perf knob.

## 2. Enrich

```bash
open pipeline/start-llm.command   # mlx_lm.server on :8090 (first run ~2.3 GB)
npm run dev                       # app on :3210
scripts/enrich-all.sh             # loops POST /api/enrich-pending until 0
```

Or by hand: `curl -X POST http://localhost:3210/api/enrich-pending` until it
returns `{"enriched":0}`. This fills `entities` — the named films, job portals,
AI models, universities, and scholarships that make `list_entities` useful.

## 3. Connect it to Claude

```bash
claude mcp add reel-vault -- node "$(pwd)/mcp/reel-vault-mcp.mjs"
```

Verify by hand at any time:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"vault_stats","arguments":{}}}' \
  | node mcp/reel-vault-mcp.mjs
```

The server is **read-only** and has no npm dependencies — it uses Node's
built-in `node:sqlite` and speaks JSON-RPC over stdio directly.

### What it can be asked

| Tool | Answers |
|---|---|
| `search_vault` | "what did I save about scholarships in Germany" |
| `get_item` | full transcript of one reel |
| `list_entities` | "list every anime I've saved" (`kind: anime`) |
| `find_actions` | "what have I been told to actually do about jobs" |
| `list_categories` | what's in here, and how much is enriched |
| `recent_items` | "what did I save this week" |
| `vault_stats` | coverage — is a gap real, or just not extracted yet |

`vault_stats` matters more than it looks. Without it, an empty search result is
ambiguous between "you never saved anything about this" and "that reel exists
but has no extracted text yet" — and the first answer, said confidently, is a
lie about your own knowledge. Every search that finds nothing reports how much
of the vault is still unread.

## Environment variables

| Var | Default | Effect |
|---|---|---|
| `APIFY_TOKEN` | unset | Enables Apify Free fetcher (required for `--run`) |
| `LLM_PROVIDER` | `local` | `local` or `groq` |
| `LLM_BASE_URL` | `http://127.0.0.1:8090/v1` / Groq | OpenAI-compatible base |
| `LLM_MODEL` | Qwen3-4B / gpt-oss-120b | Must be on the allow-list |
| `GROQ_API_KEY` | unset | Required only when `LLM_PROVIDER=groq` |
| `KEEP_MEDIA` | unset | Keep downloaded mp4s under `data/media/` |
| `REEL_VAULT_WHISPER_MODEL` | `mlx-community/whisper-small-mlx` | Whisper weights |
| `IG_MEDIA_MIN_INTERVAL_SECONDS` | `25` | Sidecar-only pacing (ban guard) |

## Honest limitations

- **Apify Free is credit, not money — until a card is attached.** Use an account
  with no payment method. Guardrails abort if the plan looks paid or credit
  would pass $4.50 this cycle.
- **Music-only reels yield nothing.** Transcripts under 15 characters are
  discarded rather than stored as hallucinated lyrics, so aesthetic reels stay
  caption/OCR-only.
- **Optional sidecar risk is real.** `instagrapi` uses Instagram's private API.
  Prefer Apify for the default path.
