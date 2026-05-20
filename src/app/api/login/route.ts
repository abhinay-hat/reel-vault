import { NextRequest, NextResponse } from "next/server";
import { isValidPasscode, PASSCODE_COOKIE } from "@/lib/passcode";

export async function POST(req: NextRequest) {
  const { passcode } = await req.json();
  if (!isValidPasscode(passcode)) {
    return NextResponse.json({ error: "wrong passcode" }, { status: 401 });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(PASSCODE_COOKIE, "ok", {
    httpOnly: true,
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 365,
    path: "/",
  });
  return res;
}
