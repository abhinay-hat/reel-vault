export interface Enrichment {
  summary: string;
  category: string;
  tags: string[];
}

export function buildEnrichPrompt(title: string, caption: string, content?: string): string {
  const base = `You organize a personal knowledge base of saved tutorial reels and articles.
Given the item below, respond with ONLY a JSON object, no prose, with keys:
- "summary": one sentence, max 25 words
- "category": a short title-case category (e.g. "Video Editing", "Image Styles", "Photography")
- "tags": array of 2-5 short lowercase tags

Title: ${title}
Caption: ${caption}`;
  const trimmed = content?.trim();
  if (!trimmed) return base;
  // Summarize from the full extracted text, not just the caption, when available.
  return `${base}
Full content (markdown, may be truncated):
${trimmed.slice(0, 4000)}`;
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

// ----------------------------- knowledge extraction -----------------------------

/**
 * The kinds of thing worth pulling out of a reel and listing on its own.
 *
 * Declared here rather than in db.ts because this is where the value is
 * validated, and because ai.ts is dependency-free — db.ts can import the type
 * (erased at compile time) without dragging node:sqlite into the pure tests.
 */
export const ENTITY_KINDS = [
  "movie", "anime", "show", "book", "tool", "ai_model", "job_portal",
  "company", "university", "scholarship", "person", "place", "course", "other",
] as const;

export type EntityKind = (typeof ENTITY_KINDS)[number];

/** A named thing worth listing on its own, pulled out of a reel. */
export interface ExtractedEntity {
  kind: EntityKind;
  name: string;
  url?: string;
  note?: string;
}

export interface Knowledge {
  summary: string;
  category: string;
  tags: string[];
  entities: ExtractedEntity[];
  actions: string[];
}

/** The reel's own words, from all three places it keeps them. */
export interface ReelContent {
  title: string;
  caption?: string | null;
  transcript?: string | null;
  onScreenText?: string | null;
}

/**
 * Category names the vault steers toward. Deliberately a *suggestion*, not an
 * enum: a fixed list forces every unfamiliar reel into "Other", and the whole
 * value of this vault is that it holds an unpredictable mix. The model may coin
 * a new category when nothing here fits, and these names keep the common cases
 * from fragmenting into six spellings of the same idea.
 */
export const CATEGORY_HINTS = [
  "Movies & Shows",
  "Anime",
  "Books",
  "Abroad Studies",
  "Scholarships",
  "Jobs & Careers",
  "Job Portals",
  "Interview Prep",
  "AI & Models",
  "Tools & Apps",
  "Programming",
  "Business & Money",
  "Health & Fitness",
  "Food & Recipes",
  "Travel",
  "Design",
  "Video Editing",
  "Photography",
  "Learning Resources",
] as const;

/**
 * Build the prompt that turns a reel's raw text into a structured record.
 *
 * The three sources are labelled rather than concatenated because they are not
 * equally trustworthy. A transcript of a noisy reel is full of filler; on-screen
 * text is terse but usually the actual point; a caption is often marketing. The
 * model needs to know which is which to weigh them.
 */
export function buildKnowledgePrompt(c: ReelContent): string {
  const parts: string[] = [`Title: ${c.title || "(untitled)"}`];
  if (c.caption?.trim()) parts.push(`Caption (the poster's own words):\n${c.caption.trim().slice(0, 2000)}`);
  if (c.onScreenText?.trim()) parts.push(`Text shown on screen (usually the key points):\n${c.onScreenText.trim().slice(0, 2000)}`);
  if (c.transcript?.trim()) parts.push(`Spoken transcript (may contain filler or transcription errors):\n${c.transcript.trim().slice(0, 6000)}`);

  return `You are building a personal knowledge base out of short videos someone saved. They save a wide mix: film and anime recommendations, study-abroad and scholarship advice, job portals and career tips, and new AI models and tools.

Read the material below and respond with ONLY a JSON object, no prose:

{
  "summary": "2-3 sentences on what this actually teaches or recommends. Be specific and concrete — name the thing, state the claim. Never write 'this video discusses...'.",
  "category": "one short Title Case category",
  "tags": ["3-6 short lowercase tags"],
  "entities": [{"kind": "...", "name": "...", "url": "optional", "note": "optional, why it came up"}],
  "actions": ["concrete steps this reel asks the viewer to take, imperative, max 5"]
}

Prefer these categories when one fits, otherwise coin a better one:
${CATEGORY_HINTS.join(", ")}

"entities" is the important field. Pull out every specific named thing so it can be listed later — the films to watch, the portals to apply on, the models to try, the universities named. Use these kinds:
${ENTITY_KINDS.join(", ")}
Name real, specific things only. A reel recommending three anime yields three entities. A vague motivational reel yields none — return [] rather than inventing.

"actions" is only for things the viewer is meant to DO ("apply before the March deadline", "try Whisper for transcription"). If the reel is purely informational or a recommendation, return [].

Base everything on the material below. Do not add facts that are not there.

${parts.join("\n\n")}`;
}

/**
 * Parse the model's reply into a Knowledge record.
 *
 * Every field degrades independently: a malformed entity list should not cost
 * you the summary. Enrichment runs unattended across hundreds of items, so
 * partial output that is correct beats an exception that loses the whole item.
 */
export function parseKnowledgeResponse(raw: string): Knowledge {
  const empty: Knowledge = { summary: "", category: "", tags: [], entities: [], actions: [] };
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  let body = (fenced ? fenced[1] : raw).trim();
  // Models sometimes prepend a sentence before the JSON. Fall back to the
  // outermost braces rather than discarding a reply that is 95% usable.
  if (!body.startsWith("{")) {
    const first = body.indexOf("{");
    const last = body.lastIndexOf("}");
    if (first !== -1 && last > first) body = body.slice(first, last + 1);
  }
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return empty;
  }
  const strings = (v: unknown, cap: number): string[] =>
    Array.isArray(v)
      ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "")
         .map((s) => s.trim())
         .slice(0, cap)
      : [];

  return {
    summary: typeof obj.summary === "string" ? obj.summary.trim() : "",
    category: typeof obj.category === "string" ? obj.category.trim() : "",
    tags: strings(obj.tags, 8).map((t) => t.toLowerCase()),
    entities: Array.isArray(obj.entities)
      ? obj.entities.flatMap((e: unknown): ExtractedEntity[] => {
          if (!e || typeof e !== "object") return [];
          const r = e as Record<string, unknown>;
          const name = typeof r.name === "string" ? r.name.trim() : "";
          if (!name) return [];
          const kind = typeof r.kind === "string" ? r.kind.trim().toLowerCase() : "other";
          return [{
            // An unrecognised kind becomes "other" rather than being dropped:
            // the name is the valuable part, the label is just a filter.
            kind: (ENTITY_KINDS as readonly string[]).includes(kind)
              ? (kind as EntityKind)
              : "other",
            name,
            ...(typeof r.url === "string" && r.url.trim() ? { url: r.url.trim() } : {}),
            ...(typeof r.note === "string" && r.note.trim() ? { note: r.note.trim() } : {}),
          }];
        }).slice(0, 20)
      : [],
    actions: strings(obj.actions, 5),
  };
}

// ----------------------------- chat over the vault -----------------------------

export interface ChatCandidate {
  id: string;
  title: string;
  category: string;
  tags: string[];
  summary: string | null;
}

export interface ChatResult {
  ids: string[];
  answer: string;
}

export function buildChatPrompt(query: string, candidates: ChatCandidate[]): string {
  const list = candidates
    .map((c) => {
      const tags = c.tags.length ? c.tags.join(", ") : "none";
      const summary = c.summary?.trim() || "none";
      return `- id: ${c.id}
  title: ${c.title}
  category: ${c.category}
  tags: ${tags}
  summary: ${summary}`;
    })
    .join("\n");
  return `You help a user search their personal vault of saved tutorial reels and articles.
The user asked: "${query}"

Here are the candidate items (already keyword-matched):
${list || "(no candidates)"}

Respond with ONLY a JSON object, no prose, with keys:
- "ids": array of the candidate ids most relevant to the query, most relevant first (only ids from the list above; empty array if none fit)
- "answer": a 1-2 sentence answer to the user. Refer to items by their title in plain language; never print raw ids in the answer.`;
}

export function parseChatResponse(raw: string): ChatResult {
  const empty: ChatResult = { ids: [], answer: "" };
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fenced ? fenced[1] : raw).trim();
  try {
    const obj = JSON.parse(body);
    return {
      ids: Array.isArray(obj.ids)
        ? obj.ids.filter((x: unknown) => typeof x === "string")
        : [],
      answer: typeof obj.answer === "string" ? obj.answer : "",
    };
  } catch {
    return empty;
  }
}

// ---------------------------------------------------------------- RAG chat

/** Ask for search terms so "chatbot" also finds reels that say "AI assistant". */
export function buildQueryExpansionPrompt(query: string): string {
  return `A user is searching their personal vault of saved Instagram reels (tech tools, AI, anime, design, jobs, study abroad).
Their question: "${query}"

List 4-8 short search terms that would appear in the transcript, caption, on-screen text or summary of a matching reel: the key words of the question, synonyms, spelling variants, and closely related product or tool names. Single words or two-word phrases.

Respond with ONLY a JSON object: {"terms": ["...", "..."]}`;
}

/** Expansion terms plus the question's own words; never empty for a non-empty query. */
export function parseQueryTerms(raw: string, query: string): string[] {
  const own = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
  let terms: string[] = [];
  const body = (raw.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1] ?? raw).trim();
  const start = body.indexOf("{");
  try {
    const obj = JSON.parse(start >= 0 ? body.slice(start, body.lastIndexOf("}") + 1) : body);
    if (Array.isArray(obj.terms)) terms = obj.terms.filter((t: unknown): t is string => typeof t === "string");
  } catch {
    // The question's own words still search fine without expansion.
  }
  return [...new Set([...terms.map((t) => t.trim().toLowerCase()), ...own])].filter(Boolean);
}

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "what", "which", "where", "how", "who", "are", "was",
  "were", "any", "all", "about", "from", "show", "find", "list", "give", "tell", "reel", "reels",
  "video", "videos", "saved", "have", "has", "did", "does", "can", "you", "me", "my", "some",
]);

export interface RagSource {
  n: number;
  title: string;
  category: string;
  date: string;
  summary: string | null;
  /** The reel's own words around the match. */
  evidence: string;
}

export function buildRagPrompt(query: string, sources: RagSource[]): string {
  const list = sources
    .map(
      (s) => `[${s.n}] ${s.title}
category: ${s.category} | saved: ${s.date}
summary: ${s.summary?.trim() || "(not summarised yet)"}
in the reel: ${s.evidence.replace(/[«»]/g, "") || "(no transcript or on-screen text)"}`,
    )
    .join("\n\n");
  return `You answer questions about the user's own vault of saved Instagram reels. Use ONLY the reels below; never invent tools, links or claims that are not in them.

Question: "${query}"

Reels found:
${list}

Write the answer in plain markdown:
1. Start with 1-2 sentences that directly answer the question.
2. Then one bullet per reel that is actually relevant, most useful first, in this form:
   - **[n] Short title** — what this reel shows and how it explains or recommends it: name the tools, steps, prices or claims it makes.
3. Leave out reels that do not fit the question. If none fit, say so in one sentence.
Cite reels only as [n]. No JSON, no preamble.`;
}

/** Reel numbers the answer cites, in first-mention order. */
export function citedNumbers(answer: string): number[] {
  const seen: number[] = [];
  for (const m of answer.matchAll(/\[(\d+)\]/g)) {
    const n = Number(m[1]);
    if (!seen.includes(n)) seen.push(n);
  }
  return seen;
}
