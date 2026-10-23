import { NextRequest, NextResponse } from "next/server";
import { getItem, updateItem } from "@/lib/db";
import { cacheMedia, isCached, isExpired } from "@/lib/media";

/**
 * Play one item's reel, holding the bytes on the way through.
 *
 * Caching every video during a sync would mean gigabytes and many extra minutes
 * before the first card appears, so the copy happens the first time someone
 * actually watches: fetch from Instagram once, write it to the media directory,
 * record the filename, and from then on serve the local file forever.
 *
 * Redirecting (rather than streaming through) hands the byte-range work to
 * /api/media/[file], which is what makes scrubbing work.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const item = await getItem(id);
  if (!item) return new Response("Not found", { status: 404 });

  if (item.video_file && (await isCached(item.video_file))) {
    return NextResponse.redirect(new URL(`/api/media/${item.video_file}`, _req.url), 302);
  }

  if (!item.video) {
    return NextResponse.json({ error: "no_video" }, { status: 404 });
  }
  if (isExpired(item.video)) {
    // The signed CDN link died before anyone watched it. Only a fresh sync can
    // produce a new one, so say that instead of failing silently.
    return NextResponse.json({ error: "link_expired" }, { status: 410 });
  }

  const file = await cacheMedia(item.video, "video");
  if (!file) {
    return NextResponse.json({ error: "fetch_failed" }, { status: 502 });
  }
  await updateItem(id, { video_file: file });
  return NextResponse.redirect(new URL(`/api/media/${file}`, _req.url), 302);
}
