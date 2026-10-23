import { NextResponse } from "next/server";
import { bridge } from "@/lib/ig";

// Disconnects the linked Instagram account on the local helper (clears its
// session + device identity) so a different account can be connected.
export async function POST() {
  try {
    const out = await bridge("/logout", { method: "POST", body: "{}" });
    return NextResponse.json(out);
  } catch {
    return NextResponse.json(
      { ok: false, error: "bridge_unreachable" },
      { status: 502 },
    );
  }
}
