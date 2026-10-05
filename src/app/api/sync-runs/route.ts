import { NextResponse } from "next/server";
import { listSyncRuns } from "@/lib/db";

export async function GET() {
  return NextResponse.json({ runs: await listSyncRuns(10) });
}
