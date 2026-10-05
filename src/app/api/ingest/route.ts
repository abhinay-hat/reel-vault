import { NextRequest, NextResponse } from "next/server";
import { ExportConnector } from "@/lib/connectors/export-connector";
export const maxDuration = 300;
export async function POST(req: NextRequest) {
  const buf = await req.arrayBuffer();
  if (!buf.byteLength) return NextResponse.json({ error: "empty body" }, { status: 400 });
  try {
    const result = await new ExportConnector().ingest(buf);
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
