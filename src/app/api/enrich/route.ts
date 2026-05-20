import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { buildEnrichPrompt, parseEnrichResponse } from "@/lib/ai";

export async function POST(req: NextRequest) {
  const { title, caption } = await req.json();
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ summary: "", category: "", tags: [] });
  }
  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const msg = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 300,
      messages: [
        { role: "user", content: buildEnrichPrompt(title ?? "", caption ?? "") },
      ],
    });
    const text = msg.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("");
    return NextResponse.json(parseEnrichResponse(text));
  } catch {
    return NextResponse.json({ summary: "", category: "", tags: [] });
  }
}
