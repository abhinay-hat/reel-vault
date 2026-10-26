import { NextRequest, NextResponse } from "next/server";
import { parseOembed, parseOpenGraph, detectSource } from "@/lib/metadata";
import { assertPublicHttpUrl, safeFetchBuffer } from "@/lib/url-safety";

export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get("url");
  if (!url) {
    return NextResponse.json({ error: "missing url" }, { status: 400 });
  }
  try {
    await assertPublicHttpUrl(url);
  } catch {
    return NextResponse.json({ error: "url_not_allowed" }, { status: 400 });
  }
  const source = detectSource(url);

  if (source === "instagram") {
    const oembedUrl = `https://api.instagram.com/oembed/?url=${encodeURIComponent(url)}`;
    try {
      const { status, buffer } = await safeFetchBuffer(oembedUrl, {
        timeoutMs: 10_000,
        maxBytes: 1_000_000,
      });
      if (status >= 200 && status < 300) {
        return NextResponse.json({
          ...parseOembed(JSON.parse(buffer.toString("utf8"))),
          source,
        });
      }
    } catch {
      // fall through to OpenGraph
    }
  }

  try {
    const { status, buffer } = await safeFetchBuffer(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; ReelVault/1.0)" },
      timeoutMs: 10_000,
      maxBytes: 2_000_000,
    });
    if (status < 200 || status >= 300) {
      return NextResponse.json(
        { title: "", author: null, thumbnail: null, caption: "", source },
        { status: 200 },
      );
    }
    const html = buffer.toString("utf8");
    return NextResponse.json({ ...parseOpenGraph(html), source });
  } catch {
    return NextResponse.json(
      { title: "", author: null, thumbnail: null, caption: "", source },
      { status: 200 },
    );
  }
}
