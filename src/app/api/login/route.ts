import { NextRequest, NextResponse } from "next/server";
import {
  isValidPasscode,
  PASSCODE_COOKIE,
  mintAuthCookie,
  loginRateLimit,
  loginClientKey,
  requestIsHttps,
} from "@/lib/passcode";

export async function POST(req: NextRequest) {
  const key = loginClientKey(req);
  if (!loginRateLimit(key)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }
  const { passcode } = await req.json();
  if (!isValidPasscode(passcode)) {
    return NextResponse.json({ error: "wrong passcode" }, { status: 401 });
  }
  const { value, maxAge } = await mintAuthCookie(passcode);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(PASSCODE_COOKIE, value, {
    httpOnly: true,
    sameSite: "lax",
    secure: requestIsHttps(req),
    maxAge,
    path: "/",
  });
  return res;
}
