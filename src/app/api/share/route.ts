import { NextRequest, NextResponse } from "next/server";
import { parseOpenGraph, detectSource } from "@/lib/metadata";
import { upsertItem } from "@/lib/db";
import { cacheMedia } from "@/lib/media";

// Token-authenticated capture endpoint for the iOS Shortcut (and any other
// external pusher). iOS has no PWA share_target, so the share sheet path is:
// Instagram Share -> Shortcut "Save to Reel Vault" -> POST here.
//
// Auth: Authorization: Bearer <SHARE_TOKEN>  (env SHARE_TOKEN, required).
// Body: JSON {"url": "..."} or {"text": "...anything containing a URL..."},
// or plain text. The first http(s) URL found is saved.

const URL_RE = /https?:\/\/[^\s"'<>]+/;

export async function POST(req: NextRequest) {
  const token = process.env.SHARE_TOKEN;
  if (!token) {
    return NextResponse.json({ error: "share_disabled", detail: "Set SHARE_TOKEN in .env.local to enable share capture." }, { status: 503 });
  }
  const auth = req.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${token}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let raw = "";
  const ct = req.headers.get("content-type") ?? "";
  try {
    if (ct.includes("application/json")) {
      const body = await req.json();
      raw = [body.url, body.text, body.title].filter((v) => typeof v === "string").join(" ");
    } else if (ct.includes("form")) {
      const form = await req.formData();
      raw = [form.get("url"), form.get("text"), form.get("title")].filter((v) => typeof v === "string").join(" ");
    } else {
      raw = await req.text();
    }
  } catch {
    return NextResponse.json({ error: "bad_body" }, { status: 400 });
  }

  const match = raw.match(URL_RE);
  if (!match) {
    return NextResponse.json({ error: "no_url", detail: "No http(s) URL found in the shared content." }, { status: 400 });
  }
  const url = match[0];
  const source = detectSource(url);

  // Best-effort title/thumbnail; Instagram often serves a login wall to
  // server-side fetches, so failures are expected and fine. Real enrichment
  // happens later via the enrich-pending worker.
  let title = "Shared link";
  let thumbnail: string | null = null;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; ReelVault/1.0)" },
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const meta = parseOpenGraph(await res.text());
      if (meta.title) title = meta.title;
      if (meta.thumbnail) thumbnail = meta.thumbnail;
    }
  } catch {
    // keep defaults
  }

  await upsertItem({
    url, source, title, author: null, thumbnail,
    summary: null, category: "Uncategorized", tags: [], notes: null,
    origin: "manual",
    // Hold the bytes now: an OG image behind a CDN can expire or move, and a
    // share saved today should still show its picture in a year.
    media_file: await cacheMedia(thumbnail, "thumb"),
  });
  return NextResponse.json({ ok: true, url, title });
}
