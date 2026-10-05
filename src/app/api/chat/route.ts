import { NextRequest, NextResponse } from "next/server";
import { buildChatPrompt, parseChatResponse, type ChatCandidate } from "@/lib/ai";
import { llmEnabled, llmComplete } from "@/lib/llm";
import { searchItemsExpanded, getItemsByIds, type Item } from "@/lib/db";

export const maxDuration = 60;

// POST /api/chat  { query: string } -> { answer: string, items: Item[] }
export async function POST(req: NextRequest) {
  const { query } = await req.json().catch(() => ({ query: "" }));
  const q = typeof query === "string" ? query.trim() : "";

  const candidates: Item[] = q ? await searchItemsExpanded(q, 40) : [];

  // No-LLM fallback: just return the keyword matches.
  if (!llmEnabled() || !candidates.length) {
    return NextResponse.json({ answer: "", items: candidates });
  }

  try {
    const compact: ChatCandidate[] = candidates.map((c) => ({
      id: c.id,
      title: c.title,
      category: c.category,
      tags: c.tags,
      summary: c.summary,
    }));
    const text = await llmComplete(buildChatPrompt(q, compact), 500);
    const { ids, answer } = parseChatResponse(text);

    // Map ids back to full Item objects (order preserved), restricted to candidates.
    const valid = new Set(candidates.map((c) => c.id));
    const chosen = ids.filter((id) => valid.has(id));
    // If the model picked no valid ids, fall back to the keyword candidates so the
    // UI still shows the relevant matches rather than an empty result.
    const items = chosen.length ? await getItemsByIds(chosen) : candidates;
    return NextResponse.json({ answer, items });
  } catch (err) {
    console.error("[/api/chat] LLM error:", err);
    return NextResponse.json({ answer: "", items: candidates });
  }
}
