import { afterEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";

afterEach(() => {
  vi.resetModules();
  delete process.env.REEL_VAULT_DB;
});

const share = {
  url: "https://www.instagram.com/reel/RESYNC/",
  source: "instagram" as const,
  title: "Shared by 1486093387",
  author: null,
  thumbnail: null,
  summary: null,
  category: "Shared in DMs",
  tags: [],
  notes: null,
  origin: "dm_shared" as const,
};

describe("re-sync of a described card", () => {
  it("keeps the AI title and category, filters find it", async () => {
    const path = "/tmp/rv-resync.db";
    for (const f of [path, `${path}-wal`, `${path}-shm`]) rmSync(f, { force: true });
    process.env.REEL_VAULT_DB = path;
    const { upsertItem, updateItem, getItem, filterItems } = await import("./db");

    const it0 = await upsertItem(share);
    await updateItem(it0.id, {
      title: "Free AI image generator",
      category: "AI & Models",
      summary: "A free tool for AI images.",
      tags: ["ai", "images"],
    });
    await upsertItem(share); // the next DM gather sees the same reel again

    const after = await getItem(it0.id);
    expect(after?.title).toBe("Free AI image generator");
    expect(after?.category).toBe("AI & Models");
    expect((await filterItems({ category: "AI & Models", tag: "ai", status: "described" })).map((i) => i.id)).toEqual([it0.id]);
    expect(await filterItems({ tag: "a" })).toEqual([]); // whole-tag match, not substring
  });
});
