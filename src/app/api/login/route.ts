import { NextRequest, NextResponse } from "next/server";
import {
  isValidPasscode,
  PASSCODE_COOKIE,
  authCookieValue,
} from "@/lib/passcode";

export async function POST(req: NextRequest) {
  const { passcode } = await req.json();
  if (!isValidPasscode(passcode)) {
    return NextResponse.json({ error: "wrong passcode" }, { status: 401 });
  }
  const token = await authCookieValue(passcode);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(PASSCODE_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 365,
    path: "/",
  });
  return res;
}
