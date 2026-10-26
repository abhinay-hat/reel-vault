import { NextRequest, NextResponse } from "next/server";
import { bridge } from "@/lib/ig";

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  // Never forward a client-supplied proxy: that would send Instagram credentials
  // through an attacker-controlled hop.
  const { proxy: _proxy, ...safe } = body;
  try {
    const out = await bridge("/login", { method: "POST", body: JSON.stringify(safe) });
    return NextResponse.json(out);
  } catch {
    return NextResponse.json(
      { ok: false, error: "bridge_unreachable", detail: "Instagram sidecar not running on 127.0.0.1:8765." },
      { status: 502 },
    );
  }
}
