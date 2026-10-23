import { NextRequest, NextResponse } from "next/server";
import { buildEnrichPrompt, parseEnrichResponse } from "@/lib/ai";
import { llmEnabled, llmComplete } from "@/lib/llm";
import { convertToMarkdown } from "@/lib/ig";

export async function POST(req: NextRequest) {
  const { title, caption, url } = await req.json();
  if (!llmEnabled()) {
    return NextResponse.json({ summary: "", category: "", tags: [] });
  }
  try {
    const content = typeof url === "string" && url ? await convertToMarkdown(url) : undefined;
    const text = await llmComplete(
      buildEnrichPrompt(title ?? "", caption ?? "", content),
      300,
    );
    return NextResponse.json(parseEnrichResponse(text));
  } catch (err) {
    console.error("[/api/enrich] LLM error:", err);
    return NextResponse.json({ summary: "", category: "", tags: [] });
  }
}
