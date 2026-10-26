import { describe, it, expect } from "vitest";

// A re-sync must refresh what Instagram owns (title, author, video) without
// destroying what the vault owns (AI summary, tags, hand-written notes).
describe("upsertItem re-sync", () => {
  it("refreshes remote fields and keeps locally-authored ones", async () => {
    const { rmSync } = await import("node:fs");
    const path = "/tmp/rv-upsert-test.db";
    for (const f of [path, `${path}-journal`, `${path}-wal`, `${path}-shm`]) {
      rmSync(f, { force: true });
    }
    process.env.REEL_VAULT_DB = path;
    const { upsertItem, updateItem, getItem } = await import("./db");

    const first = await upsertItem({
      url: "https://www.instagram.com/reel/ABC/",
      source: "instagram",
      title: "Shared by 1000000000",
      author: "1000000000",
      thumbnail: null,
      summary: null,
      category: "Shared in DMs",
      tags: [],
      notes: null,
      origin: "dm_shared",
      video: null,
      media_file: "cached-thumb.jpg",
    });

    // Enrichment and the owner add things Instagram knows nothing about.
    await updateItem(first.id, {
      summary: "A cat knocks a mug off a table.",
      tags: ["cats"],
      notes: "send to mom",
    });

    // The same reel comes back on the next sync, now with real metadata.
    await upsertItem({
      url: "https://www.instagram.com/reel/ABC/",
      source: "instagram",
      title: "my cat, the menace",
      author: "regreat_life",
      thumbnail: "https://cdn.example/thumb.jpg",
      summary: null,
      category: "Shared in DMs",
      tags: [],
      notes: null,
      origin: "dm_shared",
      video: "https://cdn.example/reel.mp4",
      media_file: null,
    });

    const after = await getItem(first.id);
    // Refreshed from Instagram:
    expect(after?.title).toBe("my cat, the menace");
    expect(after?.author).toBe("regreat_life");
    expect(after?.video).toBe("https://cdn.example/reel.mp4");
    // Kept, because a sync must never erase these:
    expect(after?.summary).toBe("A cat knocks a mug off a table.");
    expect(after?.tags).toEqual(["cats"]);
    expect(after?.notes).toBe("send to mom");
    expect(after?.media_file).toBe("cached-thumb.jpg");
  });
});
