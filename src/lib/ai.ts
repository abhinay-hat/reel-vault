export interface Enrichment {
  summary: string;
  category: string;
  tags: string[];
}

export function buildEnrichPrompt(title: string, caption: string): string {
  return `You organize a personal knowledge base of saved tutorial reels and articles.
Given the item below, respond with ONLY a JSON object, no prose, with keys:
- "summary": one sentence, max 25 words
- "category": a short title-case category (e.g. "Video Editing", "Image Styles", "Photography")
- "tags": array of 2-5 short lowercase tags

Title: ${title}
Caption: ${caption}`;
}

export function parseEnrichResponse(raw: string): Enrichment {
  const empty: Enrichment = { summary: "", category: "", tags: [] };
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fenced ? fenced[1] : raw).trim();
  try {
    const obj = JSON.parse(body);
    return {
      summary: typeof obj.summary === "string" ? obj.summary : "",
      category: typeof obj.category === "string" ? obj.category : "",
      tags: Array.isArray(obj.tags)
        ? obj.tags.filter((t: unknown) => typeof t === "string")
        : [],
    };
  } catch {
    return empty;
  }
}
