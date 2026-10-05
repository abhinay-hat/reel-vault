import { NextResponse } from "next/server";
import { listItems, updateItem } from "@/lib/db";
import { cacheMedia, isCached, isExpired } from "@/lib/media";

export const maxDuration = 300;

/**
 * Pull every still-reachable picture and video onto this machine.
 *
 * Runs over the whole vault, skipping items already cached. An item whose
 * signed URL has already expired cannot be recovered from here at all — only a
 * re-sync through the Instagram helper can mint fresh URLs — so those are
 * counted and reported rather than retried pointlessly.
 */
export async function POST() {
  let cached = 0;
  let expired = 0;
  let failed = 0;
  let skipped = 0;

  try {
    const items = await listItems();

    for (const item of items) {
      const needsThumb = !(await isCached(item.media_file));
      const needsVideo = Boolean(item.video) && !(await isCached(item.video_file));

      if (!needsThumb && !needsVideo) {
        skipped++;
        continue;
      }

      // An expired signature will never answer; do not spend a request on it.
      if (needsThumb && isExpired(item.thumbnail) && !needsVideo) {
        expired++;
        continue;
      }

      const patch: { media_file?: string; video_file?: string } = {};

      if (needsThumb && !isExpired(item.thumbnail)) {
        const file = await cacheMedia(item.thumbnail, "thumb");
        if (file) patch.media_file = file;
      }
      if (needsVideo && !isExpired(item.video)) {
        const file = await cacheMedia(item.video, "video");
        if (file) patch.video_file = file;
      }

      if (Object.keys(patch).length > 0) {
        await updateItem(item.id, patch);
        cached++;
      } else if (isExpired(item.thumbnail)) {
        expired++;
      } else {
        failed++;
      }
    }
  } catch (err) {
    console.error("[/api/media/repair]", err);
    return NextResponse.json({ error: "repair_failed" }, { status: 500 });
  }

  return NextResponse.json({
    cached,
    expired,
    failed,
    skipped,
    note:
      expired > 0
        ? `${expired} items have expired Instagram links. Only a re-sync can mint fresh ones.`
        : undefined,
  });
}
