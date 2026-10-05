import { NextRequest, NextResponse } from "next/server";
import { bridge } from "@/lib/ig";

// Kicks off a gather job on the sidecar; returns { job_id }.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  try {
    const out = await bridge("/gather", { method: "POST", body: JSON.stringify(body) });
    return NextResponse.json(out);
  } catch {
    return NextResponse.json({ error: "bridge_unreachable" }, { status: 502 });
  }
}
