import { NextResponse } from "next/server";
import { getVaultState } from "@/lib/db";

// The state line renders on every screen, including the client-rendered ones,
// so the numbers come over the wire rather than through a server component.
export async function GET() {
  try {
    return NextResponse.json(await getVaultState());
  } catch {
    // An unopenable database is itself a state worth drawing, not a crash.
    return NextResponse.json({ error: "unreachable" }, { status: 503 });
  }
}
