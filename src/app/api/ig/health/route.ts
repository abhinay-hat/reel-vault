import { NextResponse } from "next/server";
import { bridge } from "@/lib/ig";

// Cheap liveness/session probe for the sync dashboard. /api/ig/info costs three
// Instagram calls; this one only asks the local helper about itself.
export async function GET() {
  try {
    const health = await bridge("/health");
    return NextResponse.json(health);
  } catch {
    return NextResponse.json({ error: "bridge_unreachable" }, { status: 502 });
  }
}
