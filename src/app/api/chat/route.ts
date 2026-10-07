import { NextRequest, NextResponse } from "next/server";
import {
  buildQueryExpansionPrompt,
  buildRagPrompt,
  citedNumbers,
  parseQueryTerms,
  type RagSource,
} from "@/lib/ai";
import { llmComplete, llmReachable } from "@/lib/llm";
import { ragSearch, searchItemsExpanded, type Item, type RagHit } from "@/lib/db";

export const maxDuration = 120;

const TOP_K = 10;

/**
 * POST /api/chat { query } -> { answer, items, sources, terms }
 *
 * RAG over the vault: the LLM widens the question into search terms, FTS5 ranks
 * reels on everything they say (title, summary, tags, entities, caption,
 * transcript, on-screen text), and the LLM answers from those reels only,
 * citing them as [n]. Each step degrades: no LLM -> plain search results.
 */
export async function POST(req: NextRequest) {
  const { query } = await req.json().catch(() => ({ query: "" }));
  const q = typeof query === "string" ? query.trim() : "";
  if (!q) return NextResponse.json({ answer: "", items: [], sources: [], terms: [] });

  const useLlm = await llmReachable();
  let terms = parseQueryTerms("", q);
  if (useLlm) {
    try {
      terms = parseQueryTerms(await llmComplete(buildQueryExpansionPrompt(q), 200), q);
    } catch (err) {
      console.error("[/api/chat] expansion failed, searching the question's own words:", err);
    }
  }

  let hits: RagHit[] = await ragSearch(terms, TOP_K);
  if (!hits.length) {
    // FTS found nothing (e.g. a one-letter query): fall back to substring search.
    hits = (await searchItemsExpanded(q, TOP_K)).map((item) => ({ item, evidence: "" }));
  }

  const sources = hits.map((h, i) => ({ n: i + 1, id: h.item.id, evidence: h.evidence }));
  const items: Item[] = hits.map((h) => h.item);
  if (!useLlm || !hits.length) {
    return NextResponse.json({ answer: "", items, sources, terms, llm: useLlm });
  }

  try {
    const context: RagSource[] = hits.map((h, i) => ({
      n: i + 1,
      title: h.item.title,
      category: h.item.category,
      date: (h.item.created_at ?? "").slice(0, 10),
      summary: h.item.summary,
      evidence: h.evidence,
    }));
    const answer = (await llmComplete(buildRagPrompt(q, context), 1200)).trim();
    // Cited reels first, in the order the answer mentions them; then the rest.
    const cited = citedNumbers(answer).filter((n) => n >= 1 && n <= hits.length);
    const order = [...cited, ...sources.map((s) => s.n).filter((n) => !cited.includes(n))];
    return NextResponse.json({
      answer,
      items: order.map((n) => items[n - 1]),
      sources: order.map((n) => sources[n - 1]),
      cited,
      terms,
    });
  } catch (err) {
    console.error("[/api/chat] LLM error:", err);
    return NextResponse.json({ answer: "", items, sources, terms });
  }
}
