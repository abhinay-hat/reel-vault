import { afterEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { NextRequest } from "next/server";

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  delete process.env.REEL_VAULT_DB;
  delete process.env.LLM_PROVIDER;
});

describe("POST /api/enrich-pending", () => {
  it("returns enriched/failed/remaining and increments attempts on empty summary", async () => {
    const path = "/tmp/rv-enrich-route.db";
    for (const f of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) {
      rmSync(f, { force: true });
    }
    process.env.REEL_VAULT_DB = path;
    process.env.LLM_PROVIDER = "local";

    vi.doMock("@/lib/llm", () => ({
      llmEnabled: () => true,
      llmComplete: vi.fn(async () => "not json at all"),
    }));

    const { upsertItem, updateItem, getItem } = await import("@/lib/db");
    const it = await upsertItem({
      url: "https://www.instagram.com/reel/ENR/",
      source: "instagram",
      title: "Shared by 1",
      author: null,
      thumbnail: null,
      summary: null,
      category: "x",
      tags: [],
      notes: null,
      origin: "dm_shared",
    });
    await updateItem(it.id, {
      content_status: "transcribed",
      caption: "Top 3 tools",
    });

    const { POST } = await import("./route");
    const req = new NextRequest("http://localhost/api/enrich-pending?limit=5", {
      method: "POST",
    });
    const res = await POST(req);
    const body = await res.json();
    expect(body.enriched).toBe(0);
    expect(body.failed).toBe(1);
    expect(typeof body.remaining).toBe("number");

    const after = await getItem(it.id);
    expect(after?.enrich_attempts).toBe(1);
    expect(after?.content_error).toMatch(/^enrich:/);
  });
});
