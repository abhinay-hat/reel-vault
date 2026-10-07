import { afterEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { citedNumbers, parseQueryTerms } from "./ai";

afterEach(() => {
  vi.resetModules();
  delete process.env.REEL_VAULT_DB;
});

describe("query terms", () => {
  it("keeps the model's expansion plus the question's own words", () => {
    const t = parseQueryTerms('{"terms": ["chat bot", "AI assistant"]}', "which chatbot reels did I save?");
    expect(t).toEqual(expect.arrayContaining(["chat bot", "ai assistant", "chatbot"]));
    expect(t).not.toContain("which");
  });
  it("falls back to the question when the model reply is not JSON", () => {
    expect(parseQueryTerms("sure! here you go", "voice agent")).toEqual(["voice", "agent"]);
  });
});

describe("citations", () => {
  it("lists cited reels once, in first-mention order", () => {
    expect(citedNumbers("Use [3] or [1]. **[3] Foo** again, and [12].")).toEqual([3, 1, 12]);
  });
});

describe("ragSearch", () => {
  it("finds a reel by what it says, not just its title, with evidence", async () => {
    const path = "/tmp/rv-rag.db";
    for (const f of [path, `${path}-wal`, `${path}-shm`]) rmSync(f, { force: true });
    process.env.REEL_VAULT_DB = path;
    const { upsertItem, updateItem, ragSearch } = await import("./db");
    const base = { source: "instagram" as const, author: null, thumbnail: null, summary: null,
      category: "Shared in DMs", tags: [], notes: null, origin: "dm_shared" as const };
    const a = await upsertItem({ ...base, url: "https://www.instagram.com/reel/AAA/", title: "Shared by 1" });
    await updateItem(a.id, { transcript: "today I will build a voice chatbot with Gemma running on an old phone" });
    await upsertItem({ ...base, url: "https://www.instagram.com/reel/BBB/", title: "Best anime of 2025" });

    const hits = await ragSearch(["chatbot"], 5);
    expect(hits.map((h) => h.item.id)).toEqual([a.id]);
    expect(hits[0].evidence).toContain("«chatbot»");
    // A later edit must be searchable without restarting (index rebuilds on change).
    await updateItem(a.id, { summary: "Self-hosted assistant" });
    expect((await ragSearch(["assistant"], 5)).map((h) => h.item.id)).toEqual([a.id]);
  });
});
