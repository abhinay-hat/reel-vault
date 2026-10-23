import { NextRequest, NextResponse } from "next/server";
import { parseOembed, parseOpenGraph, detectSource } from "@/lib/metadata";

export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get("url");
  if (!url) {
    return NextResponse.json({ error: "missing url" }, { status: 400 });
  }
  const source = detectSource(url);

  if (source === "instagram") {
    const oembedUrl = `https://api.instagram.com/oembed/?url=${encodeURIComponent(url)}`;
    try {
      const res = await fetch(oembedUrl);
      if (res.ok) {
        return NextResponse.json({ ...parseOembed(await res.json()), source });
      }
    } catch {
      // fall through to OpenGraph
    }
  }

  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; ReelVault/1.0)" },
    });
    const html = await res.text();
    return NextResponse.json({ ...parseOpenGraph(html), source });
  } catch {
    return NextResponse.json(
      { title: "", author: null, thumbnail: null, caption: "", source },
      { status: 200 },
    );
  }
}
