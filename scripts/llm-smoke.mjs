/**
 * One-shot local LLM smoke. Needs mlx_lm.server on :8090.
 * Uses the same prompt/parser as the app via vitest's TS loader when available;
 * otherwise posts a compact knowledge prompt and checks for a summary field.
 */
import { createRequire } from "node:module";

const base = process.env.LLM_BASE_URL || "http://127.0.0.1:8090/v1";
const model =
  process.env.LLM_MODEL || "mlx-community/Qwen3-4B-Instruct-2507-4bit";

let prompt;
let parse;
try {
  const require = createRequire(import.meta.url);
  // Prefer compiled-style import via tsx if the runner provides it.
  const ai = await import("../src/lib/ai.ts");
  prompt = ai.buildKnowledgePrompt({
    title: "Shared by 123",
    caption: "Top 3 AI tools for students in 2026",
    transcript: "Reel Vault smoke test. Try Whisper for transcription.",
    onScreenText: "TOP 3 AI TOOLS",
  });
  parse = ai.parseKnowledgeResponse;
} catch {
  prompt = `Return ONLY JSON with keys summary, category, tags, entities, actions.
Title: Shared by 123
Caption: Top 3 AI tools for students in 2026
Transcript: Reel Vault smoke test. Try Whisper for transcription.
On-screen: TOP 3 AI TOOLS`;
  parse = (text) => {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return { summary: "" };
    try {
      return JSON.parse(m[0]);
    } catch {
      return { summary: "" };
    }
  };
}

const res = await fetch(`${base}/chat/completions`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    model,
    max_tokens: 800,
    temperature: 0.2,
    messages: [{ role: "user", content: prompt }],
  }),
  signal: AbortSignal.timeout(180_000),
});
if (!res.ok) {
  console.error("LLM HTTP", res.status, await res.text());
  process.exit(1);
}
const data = await res.json();
const text = data.choices?.[0]?.message?.content ?? "";
const k = parse(text);
console.log("summary:", k.summary);
if (!k.summary) {
  console.error("empty summary; raw:", text.slice(0, 400));
  process.exit(2);
}
console.log("llm_smoke_ok");
