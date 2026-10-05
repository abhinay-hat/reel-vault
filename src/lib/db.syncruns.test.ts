import { describe, it, expect } from "vitest";

// The sync history is the page's "last synced" and "recent syncs" source, so
// the table must round-trip a run.
describe("sync_runs", () => {
  it("records and lists runs newest-first", async () => {
    // Start from an empty file: db() caches the handle per process, and a
    // leftover file from an earlier run would leave stale rows in front.
    const { rmSync } = await import("node:fs");
    const path = "/tmp/rv-syncruns-test.db";
    for (const f of [path, `${path}-journal`, `${path}-wal`, `${path}-shm`]) {
      rmSync(f, { force: true });
    }
    process.env.REEL_VAULT_DB = path;
    const { recordSyncRun, listSyncRuns } = await import("./db");
    await recordSyncRun({
      started_at: "2026-09-01T10:00:00Z", finished_at: "2026-09-01T10:04:00Z",
      status: "done", items: 24, conversations: 3, messages: 9, skipped: 1, error: null,
    });
    await recordSyncRun({
      started_at: "2026-09-02T10:00:00Z", finished_at: "2026-09-02T10:01:00Z",
      status: "error", items: 0, conversations: 0, messages: 0, skipped: 0, error: "rate_limited_cooldown",
    });
    const runs = await listSyncRuns(5);
    expect(runs[0].status).toBe("error");
    expect(runs[1].items).toBe(24);
  });
});
