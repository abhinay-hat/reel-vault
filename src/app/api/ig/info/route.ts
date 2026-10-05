import { NextResponse } from "next/server";
import { bridge } from "@/lib/ig";

export async function GET() {
  try {
    const [account, threads, collections] = await Promise.all([
      bridge("/account-info"),
      bridge("/threads?amount=50"),
      bridge("/collections"),
    ]);
    return NextResponse.json({ account, threads, collections });
  } catch {
    return NextResponse.json({ error: "bridge_unreachable" }, { status: 502 });
  }
}
