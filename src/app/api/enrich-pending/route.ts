import { NextResponse } from "next/server";
import { buildKnowledgePrompt, parseKnowledgeResponse } from "@/lib/ai";
import { llmEnabled, llmComplete } from "@/lib/llm";
import { updateItem, listItemsNeedingEnrichment } from "@/lib/db";

export const maxDuration = 300;

/**
 * Batch-enrich items that have extracted text but no summary yet.
 *
 * This deliberately reads only what the extraction pipeline already pulled onto
 * this machine (caption, transcript, on-screen text) instead of re-fetching the
 * page. The previous version called convertToMarkdown(url) per item, which for
 * a reel fetches an Instagram HTML shell containing no caption — so it summarised
 * nothing, for every one of the 386 DM-shared reels.
 */
export async function POST() {
  if (!llmEnabled()) {
    return NextResponse.json(
      { enriched: 0, reason: "no GROQ_API_KEY configured" },
      { status: 200 },
    );
  }
  const pending = await listItemsNeedingEnrichment(20);
  if (!pending.length) return NextResponse.json({ enriched: 0 });

  let enriched = 0;
  const failed: string[] = [];
  for (const it of pending) {
    // Nothing to read means nothing to say. Skipping keeps the item in the
    // queue for after extraction has run, rather than burning a call to
    // produce a summary of its own title.
    if (!it.caption && !it.transcript && !it.ocr_text) continue;
    try {
      const text = await llmComplete(
        buildKnowledgePrompt({
          title: it.title,
          caption: it.caption,
          transcript: it.transcript,
          onScreenText: it.ocr_text,
        }),
        1200,
      );
      const k = parseKnowledgeResponse(text);
      if (!k.summary) {
        failed.push(it.id);
        continue;
      }
      await updateItem(it.id, {
        summary: k.summary,
        category: k.category || it.category,
        tags: k.tags.length ? k.tags : it.tags,
        entities: k.entities,
        actions: k.actions,
        content_status: "enriched",
      });
      enriched++;
    } catch (err) {
      console.error("[/api/enrich-pending] LLM error:", err);
      failed.push(it.id);
    }
  }
  return NextResponse.json({ enriched, failed: failed.length });
}
