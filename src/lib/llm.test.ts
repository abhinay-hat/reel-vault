import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  process.env = { ...ORIGINAL };
  delete process.env.LLM_PROVIDER;
  delete process.env.LLM_BASE_URL;
  delete process.env.LLM_MODEL;
  delete process.env.GROQ_API_KEY;
});

afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe("llm", () => {
  it("local defaults enabled without key", async () => {
    process.env.LLM_PROVIDER = "local";
    const { llmEnabled } = await import("./llm");
    expect(llmEnabled()).toBe(true);
  });

  it("groq disabled without key", async () => {
    process.env.LLM_PROVIDER = "groq";
    const { llmEnabled } = await import("./llm");
    expect(llmEnabled()).toBe(false);
  });

  it("rejects model not on allow-list", async () => {
    process.env.LLM_PROVIDER = "local";
    process.env.LLM_MODEL = "not-on-the-allow-list";
    const { llmComplete } = await import("./llm");
    await expect(llmComplete("hi")).rejects.toThrow(/not allowed/);
  });

  it("posts OpenAI-shaped body; auth only for groq", async () => {
    process.env.LLM_PROVIDER = "groq";
    process.env.GROQ_API_KEY = "test-key";
    process.env.LLM_MODEL = "openai/gpt-oss-120b";

    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { llmComplete } = await import("./llm");
    const text = await llmComplete("prompt", 100);
    expect(text).toBe("ok");
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("api.groq.com");
    expect((init!.headers as Record<string, string>).Authorization).toBe(
      "Bearer test-key",
    );
    const body = JSON.parse(String(init!.body));
    expect(body).toMatchObject({
      model: "openai/gpt-oss-120b",
      max_tokens: 100,
      temperature: 0.2,
      messages: [{ role: "user", content: "prompt" }],
    });
  });

  it("local call has no Authorization header", async () => {
    process.env.LLM_PROVIDER = "local";
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: "local" } }] }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { llmComplete } = await import("./llm");
    await llmComplete("x");
    const init = fetchMock.mock.calls[0]![1]!;
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe("mlx-community/Qwen3-4B-Instruct-2507-4bit");
  });
});
