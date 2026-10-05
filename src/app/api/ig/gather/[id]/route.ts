import { NextRequest, NextResponse } from "next/server";
import { bridge, storeGathered, type GatheredItem } from "@/lib/ig";
import { recordSyncRun } from "@/lib/db";

// Per-job cursor: how many of the job's items we've already stored. Lets us
// store incrementally on every poll (the vault fills live during a long
// gather) without re-writing the same rows each time. started_at is stamped on
// the first poll so the finished run can be written to the sync history.
const stored = new Map<
  string,
  { count: number; items: number; conversations: number; messages: number; skipped: number; started_at: string }
>();

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const job = (await bridge(`/gather/${id}`)) as {
      status: string; progress?: string; count?: number;
      stats?: Record<string, number>; error?: string | null; items?: GatheredItem[];
    };

    const all = Array.isArray(job.items) ? job.items : [];
    const cursor =
      stored.get(id) ??
      { count: 0, items: 0, conversations: 0, messages: 0, skipped: 0, started_at: new Date().toISOString() };
    stored.set(id, cursor);

    // Store only the items we haven't stored yet (idempotent regardless).
    if (all.length > cursor.count) {
      const fresh = all.slice(cursor.count);
      const res = await storeGathered(fresh);
      cursor.count = all.length;
      cursor.items += res.items;
      cursor.conversations += res.conversations;
      cursor.messages += res.messages;
      cursor.skipped += res.skipped;
      stored.set(id, cursor);
    }

    const total = {
      items: cursor.items,
      conversations: cursor.conversations,
      messages: cursor.messages,
      skipped: cursor.skipped,
    };

    if (job.status === "done" || job.status === "error") {
      stored.delete(id);
      await recordSyncRun({
        started_at: cursor.started_at,
        finished_at: new Date().toISOString(),
        status: job.status === "done" ? "done" : "error",
        ...total,
        error: job.status === "error" ? (job.error ?? "unknown_error") : null,
      });
    }

    if (job.status === "done") {
      return NextResponse.json({
        status: "done", gathered: job.stats, stored: total, progress: job.progress,
      });
    }
    if (job.status === "error") {
      return NextResponse.json({
        status: "error", error: job.error, stored: total, progress: job.progress,
      });
    }
    // Running: report how many are in the vault so far so the UI can show it.
    return NextResponse.json({
      status: job.status, progress: job.progress, count: job.count,
      stored: total, error: job.error,
    });
  } catch {
    return NextResponse.json({ error: "bridge_unreachable" }, { status: 502 });
  }
}
