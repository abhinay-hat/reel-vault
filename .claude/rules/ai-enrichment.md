---
paths:
  - "src/lib/ai*"
  - "src/lib/llm.ts"
  - "src/app/api/enrich*/**"
  - "scripts/enrich-all.sh"
---

### AI enrichment — `src/lib/ai.ts` + `src/app/api/enrich*`

Items are saved with `summary: null` and enriched later. `ai.ts` holds the pure prompt builders and JSON parsers (tested, dependency-free — it also owns `EntityKind`, which `db.ts` imports as a type). `buildKnowledgePrompt`/`parseKnowledgeResponse` turn extracted text into summary, category, tags, `entities` (named films, portals, models, universities — the field that makes "list every anime I saved" answerable) and `actions`. Parsing degrades field by field: a malformed entity list must not cost the summary, since enrichment runs unattended.

`/api/enrich-pending` pulls up to 20 items via `listItemsNeedingEnrichment` and reads only locally-extracted text. It deliberately does **not** call `convertToMarkdown(url)` — for a reel that fetches an Instagram HTML shell with no caption in it, which is why the old version summarised nothing for all 386 DM-shared reels.

The LLM seam is `src/lib/llm.ts`: default `LLM_PROVIDER=local` → OpenAI-compatible `mlx_lm.server` (`pipeline/start-llm.command`, Qwen3-4B). Optional `groq` uses allow-listed free models only. Batch helper: `scripts/enrich-all.sh`.
