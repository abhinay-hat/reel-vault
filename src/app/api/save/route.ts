import { NextRequest, NextResponse } from "next/server";
import { detectSource, type Source } from "@/lib/metadata";
import { upsertItem } from "@/lib/db";
import { cacheMedia } from "@/lib/media";
import { assertPublicHttpUrl, parseHttpUrl } from "@/lib/url-safety";

/**
 * Cookie-authenticated save used by /add (paste URL, share_target, bookmarklet).
 * Body: { url, title?, author?, thumbnail?, summary?, category?, tags?, notes? }
 */
export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "bad_body" }, { status: 400 });
  }

  const rawUrl = typeof body.url === "string" ? body.url.trim() : "";
  if (!rawUrl) {
    return NextResponse.json({ error: "missing_url" }, { status: 400 });
  }
  try {
    await assertPublicHttpUrl(rawUrl);
  } catch {
    return NextResponse.json({ error: "url_not_allowed" }, { status: 400 });
  }
  const parsed = parseHttpUrl(rawUrl);
  if (!parsed) {
    return NextResponse.json({ error: "url_not_allowed" }, { status: 400 });
  }
  const url = parsed.toString();
  const source: Source =
    typeof body.source === "string" &&
    (body.source === "instagram" || body.source === "article" || body.source === "other")
      ? body.source
      : detectSource(url);

  const title =
    typeof body.title === "string" && body.title.trim()
      ? body.title.trim().slice(0, 300)
      : "Saved link";
  const author =
    typeof body.author === "string" && body.author.trim() ? body.author.trim() : null;
  const thumbRaw =
    typeof body.thumbnail === "string" && body.thumbnail.trim()
      ? body.thumbnail.trim()
      : null;
  const thumbnail = thumbRaw && parseHttpUrl(thumbRaw) ? thumbRaw : null;
  const summary =
    typeof body.summary === "string" && body.summary.trim() ? body.summary.trim() : null;
  const category =
    typeof body.category === "string" && body.category.trim()
      ? body.category.trim().slice(0, 80)
      : "Uncategorized";
  const tags = Array.isArray(body.tags)
    ? body.tags
        .filter((t): t is string => typeof t === "string")
        .map((t) => t.trim())
        .filter(Boolean)
        .slice(0, 24)
    : [];
  const notes =
    typeof body.notes === "string" && body.notes.trim() ? body.notes.trim() : null;

  const item = await upsertItem({
    url,
    source,
    title,
    author,
    thumbnail,
    summary,
    category,
    tags,
    notes,
    origin: "manual",
    media_file: await cacheMedia(thumbnail, "thumb"),
  });

  return NextResponse.json({ ok: true, id: item.id, url: item.url });
}
