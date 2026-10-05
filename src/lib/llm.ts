// Single LLM call seam. Uses Groq's OpenAI-compatible chat-completions API.
// Model-agnostic: the prompt builders/parsers live in `ai.ts`.

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const DEFAULT_MODEL = process.env.LLM_MODEL || "llama-3.3-70b-versatile";

/** True when an API key is configured. Missing key is a no-op, not an error. */
export function llmEnabled(): boolean {
  return !!process.env.GROQ_API_KEY;
}

/** Send a single user prompt, return the assistant text. Throws on API error. */
export async function llmComplete(prompt: string, maxTokens = 500): Promise<string> {
  const key = process.env.GROQ_API_KEY;
  if (!key) return "";
  const res = await fetch(GROQ_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: DEFAULT_MODEL,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) {
    throw new Error(`Groq ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  return data.choices?.[0]?.message?.content ?? "";
}
