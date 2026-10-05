import { NextRequest, NextResponse } from "next/server";
import { buildKnowledgePrompt, parseKnowledgeResponse } from "@/lib/ai";
import { llmEnabled, llmComplete } from "@/lib/llm";
import {
  updateItem,
  listItemsNeedingEnrichment,
  countItemsNeedingEnrichment,
} from "@/lib/db";

export const maxDuration = 300;

/**
 * Batch-enrich items that have extracted text but no summary yet.
 *
 * Reads only locally-extracted text. Retries once on parse failure. Items that
 * fail 3 times drop out of the queue via enrich_attempts so the rest of the
 * vault can still progress.
 */
export async function POST(req: NextRequest) {
  if (!llmEnabled()) {
    return NextResponse.json(
      {
        enriched: 0,
        failed: 0,
        remaining: 0,
        reason: "LLM not configured (start local server or set GROQ_API_KEY)",
      },
      { status: 200 },
    );
  }

  const rawLimit = Number(req.nextUrl.searchParams.get("limit") ?? "5");
  const limit = Math.min(20, Math.max(1, Number.isFinite(rawLimit) ? rawLimit : 5));
  const pending = await listItemsNeedingEnrichment(limit);
  if (!pending.length) {
    return NextResponse.json({
      enriched: 0,
      failed: 0,
      remaining: await countItemsNeedingEnrichment(),
    });
  }

  let enriched = 0;
  let failed = 0;
  for (const it of pending) {
    if (!it.caption && !it.transcript && !it.ocr_text) continue;
    try {
      const prompt = buildKnowledgePrompt({
        title: it.title,
        caption: it.caption,
        transcript: it.transcript,
        onScreenText: it.ocr_text,
      });
      let text = await llmComplete(prompt, 1200);
      let k = parseKnowledgeResponse(text);
      if (!k.summary) {
        text = await llmComplete(
          `${prompt}\n\nRespond with ONLY the JSON object.`,
          1200,
        );
        k = parseKnowledgeResponse(text);
      }
      if (!k.summary) {
        failed++;
        await updateItem(it.id, {
          enrich_attempts: (it.enrich_attempts ?? 0) + 1,
          content_error: "enrich: empty summary",
        });
        continue;
      }
      const patch: Parameters<typeof updateItem>[1] = {
        summary: k.summary,
        category: k.category || it.category,
        tags: k.tags.length ? k.tags : it.tags,
        entities: k.entities,
        actions: k.actions,
        content_status: "enriched",
        content_error: null,
        enrich_attempts: 0,
      };
      if (it.title.startsWith("Shared by ") && k.summary) {
        const sentence = k.summary.split(/(?<=[.!?])\s+/)[0] || k.summary;
        patch.title = sentence.slice(0, 90);
      }
      await updateItem(it.id, patch);
      enriched++;
    } catch (err) {
      console.error("[/api/enrich-pending] LLM error:", err);
      failed++;
      const reason = err instanceof Error ? err.message : String(err);
      await updateItem(it.id, {
        enrich_attempts: (it.enrich_attempts ?? 0) + 1,
        content_error: `enrich: ${reason}`.slice(0, 300),
      });
    }
  }

  return NextResponse.json({
    enriched,
    failed,
    remaining: await countItemsNeedingEnrichment(),
  });
}
