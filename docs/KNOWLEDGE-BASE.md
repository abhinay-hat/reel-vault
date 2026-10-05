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
     |     caption  <- sidecar, one reel at a time, paced
     |     transcript <- Whisper, local, free
     |     ocr_text <- keyframes read by a vision model
     v
  raw text on this machine
     |
     |  2. POST /api/enrich-pending
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
# system dependency — frame + audio handling
brew install ffmpeg

# python side of the pipeline
pip3 install -r pipeline/requirements.txt
```

`.env.local` already has both keys this needs: `GROQ_API_KEY` (enrichment) and
`ANTHROPIC_API_KEY` (reading on-screen text).

## 1. Extract

Start the Instagram sidecar first (`ig-bridge/start-bridge.command`) and make
sure `/connect` shows the account linked. Then:

```bash
python3 pipeline/extract.py --stats          # see coverage before you start
python3 pipeline/extract.py --limit 10       # try ten first
python3 pipeline/extract.py                  # the whole queue
```

Or double-click `pipeline/start-extract.command`.

**This is slow on purpose.** Every caption is one call to Instagram's private
API, paced ~25s apart. 386 reels is roughly 2.5 hours for captions alone, plus
transcription time. That pacing is the only thing standing between this backfill
and a checkpointed account — please do not lower `IG_MEDIA_MIN_INTERVAL_SECONDS`
to make it faster.

Ctrl-C is safe. Every item commits as it finishes, so re-running resumes rather
than restarts. If Instagram pushes back, the script reports the cooldown and
stops; run it again in a few hours.

Run it in a few sessions across a few days rather than one long burn.

## 2. Enrich

With the app running (`npm run dev`):

```bash
curl -X POST http://localhost:3210/api/enrich-pending   # 20 items per call
```

Repeat until it returns `{"enriched":0}`. This is what fills in `entities` —
the named films, job portals, AI models, universities, and scholarships that
make `list_entities` useful.

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

## Environment variables added

| Var | Default | Effect |
|---|---|---|
| `IG_MEDIA_MIN_INTERVAL_SECONDS` | `25` | Seconds between per-reel Instagram lookups |
| `REEL_VAULT_WHISPER_MODEL` | `small` | `tiny`/`base`/`small`/`medium` — bigger is slower and better |
| `REEL_VAULT_VISION_MODEL` | `claude-haiku-4-5-20251001` | Model that reads on-screen text |
| `REEL_VAULT_FRAMES` | `4` | Frames sampled per reel for on-screen text |

## Honest limitations

- **The account risk is real.** `instagrapi` uses Instagram's private API, which
  violates their ToS. The pacing reduces the risk; it does not remove it.
- **Music-only reels yield nothing.** Transcripts under 15 characters are
  discarded rather than stored as hallucinated lyrics, so aesthetic reels stay
  searchable only by caption and on-screen text.
- **Deleted reels are gone.** Anything that 404s is marked `unavailable` and
  never retried. The link stays in the vault; its content is unrecoverable.
- **Entities are only as good as the extraction.** A reel that names three anime
  in on-screen text only gets them if the frames were sampled where the text
  was. `FRAME_COUNT` is the dial.
