import { NextRequest, NextResponse } from "next/server";
import { parseSavedPosts } from "@/lib/instagram-export";

export async function POST(req: NextRequest) {
  const body = await req.text();
  const posts = parseSavedPosts(body);
  return NextResponse.json({ posts });
}
