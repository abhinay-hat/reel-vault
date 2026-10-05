// OpenAI-compatible LLM seam. Default: local mlx_lm.server (zero spend).
// Allow-list mirrors pipeline/reelvault/guardrails.py — anything else throws.

const ALLOWED: Record<string, string[]> = {
  local: ["mlx-community/Qwen3-4B-Instruct-2507-4bit"],
  groq: ["openai/gpt-oss-120b", "openai/gpt-oss-20b"],
};

function provider(): "local" | "groq" {
  const p = (process.env.LLM_PROVIDER || "local").toLowerCase();
  if (p !== "local" && p !== "groq") {
    throw new Error(`LLM_PROVIDER must be 'local' or 'groq' (got '${p}')`);
  }
  return p;
}

function baseUrl(): string {
  if (process.env.LLM_BASE_URL) return process.env.LLM_BASE_URL.replace(/\/$/, "");
  return provider() === "local"
    ? "http://127.0.0.1:8090/v1"
    : "https://api.groq.com/openai/v1";
}

function model(): string {
  const p = provider();
  const m =
    process.env.LLM_MODEL ||
    (p === "local"
      ? "mlx-community/Qwen3-4B-Instruct-2507-4bit"
      : "openai/gpt-oss-120b");
  if (!ALLOWED[p].includes(m)) {
    throw new Error(
      `LLM_MODEL '${m}' is not allowed for provider '${p}'. ` +
        `Allowed: ${ALLOWED[p].join(", ")}`,
    );
  }
  return m;
}

/** True when local (always) or groq with a key. Missing key is a no-op, not an error. */
export function llmEnabled(): boolean {
  try {
    if (provider() === "local") return true;
    return !!process.env.GROQ_API_KEY;
  } catch {
    return false;
  }
}

/** Send a single user prompt, return the assistant text. Throws on API error. */
export async function llmComplete(prompt: string, maxTokens = 500): Promise<string> {
  const p = provider();
  if (p === "groq" && !process.env.GROQ_API_KEY) return "";

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (p === "groq") {
    headers.Authorization = `Bearer ${process.env.GROQ_API_KEY}`;
  }

  const res = await fetch(`${baseUrl()}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: model(),
      max_tokens: maxTokens,
      temperature: 0.2,
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    throw new Error(`LLM ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  return data.choices?.[0]?.message?.content ?? "";
}
