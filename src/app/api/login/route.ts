import { NextRequest, NextResponse } from "next/server";
import {
  isValidPasscode,
  PASSCODE_COOKIE,
  authCookieValue,
  loginRateLimit,
} from "@/lib/passcode";

export async function POST(req: NextRequest) {
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "local";
  if (!loginRateLimit(ip)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }
  const { passcode } = await req.json();
  if (!isValidPasscode(passcode)) {
    return NextResponse.json({ error: "wrong passcode" }, { status: 401 });
  }
  const token = await authCookieValue(passcode);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(PASSCODE_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: req.nextUrl.protocol === "https:",
    maxAge: 60 * 60 * 24 * 365,
    path: "/",
  });
  return res;
}
