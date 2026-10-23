import { afterEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";

afterEach(() => {
  vi.resetModules();
  delete process.env.REEL_VAULT_DB;
});

describe("enrich queue", () => {
  it("excludes enrich_attempts >= 3 and orders by attempts then added_at", async () => {
    const path = "/tmp/rv-enrich-queue.db";
    for (const f of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) {
      rmSync(f, { force: true });
    }
    process.env.REEL_VAULT_DB = path;
    const { upsertItem, updateItem, listItemsNeedingEnrichment, countItemsNeedingEnrichment } =
      await import("./db");

    const a = await upsertItem({
      url: "https://www.instagram.com/reel/A/",
      source: "instagram",
      title: "a",
      author: null,
      thumbnail: null,
      summary: null,
      category: "x",
      tags: [],
      notes: null,
      origin: "dm_shared",
    });
    const b = await upsertItem({
      url: "https://www.instagram.com/reel/B/",
      source: "instagram",
      title: "b",
      author: null,
      thumbnail: null,
      summary: null,
      category: "x",
      tags: [],
      notes: null,
      origin: "dm_shared",
    });
    const c = await upsertItem({
      url: "https://www.instagram.com/reel/C/",
      source: "instagram",
      title: "c",
      author: null,
      thumbnail: null,
      summary: null,
      category: "x",
      tags: [],
      notes: null,
      origin: "dm_shared",
    });

    await updateItem(a.id, {
      content_status: "transcribed",
      caption: "cap a",
      enrich_attempts: 2,
    });
    await updateItem(b.id, {
      content_status: "transcribed",
      caption: "cap b",
      enrich_attempts: 0,
    });
    await updateItem(c.id, {
      content_status: "transcribed",
      caption: "cap c",
      enrich_attempts: 3,
    });

    const list = await listItemsNeedingEnrichment(10);
    expect(list.map((i) => i.id)).toEqual([b.id, a.id]);
    expect(list.find((i) => i.id === c.id)).toBeUndefined();
    expect(await countItemsNeedingEnrichment()).toBe(2);
  });

  it("excludes text-less transcribed rows; keeps ocr-only rows", async () => {
    const path = "/tmp/rv-enrich-notext.db";
    for (const f of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) {
      rmSync(f, { force: true });
    }
    process.env.REEL_VAULT_DB = path;
    const { upsertItem, updateItem, listItemsNeedingEnrichment, countItemsNeedingEnrichment } =
      await import("./db");

    const empty = await upsertItem({
      url: "https://www.instagram.com/reel/EMPTY/",
      source: "instagram",
      title: "music only",
      author: null,
      thumbnail: null,
      summary: null,
      category: "x",
      tags: [],
      notes: null,
      origin: "dm_shared",
    });
    const ocrOnly = await upsertItem({
      url: "https://www.instagram.com/reel/OCR/",
      source: "instagram",
      title: "slide",
      author: null,
      thumbnail: null,
      summary: null,
      category: "x",
      tags: [],
      notes: null,
      origin: "dm_shared",
    });

    await updateItem(empty.id, { content_status: "transcribed" });
    await updateItem(ocrOnly.id, {
      content_status: "transcribed",
      ocr_text: "TOP 3 AI TOOLS",
    });

    const list = await listItemsNeedingEnrichment(10);
    expect(list.map((i) => i.id)).toEqual([ocrOnly.id]);
    expect(await countItemsNeedingEnrichment()).toBe(1);
  });
});
