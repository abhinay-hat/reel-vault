import { NextRequest, NextResponse } from "next/server";
import { PASSCODE_COOKIE, requestIsHttps } from "@/lib/passcode";

/** Clear the rotating auth cookie. Always succeeds (idempotent). */
export async function POST(req: NextRequest) {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(PASSCODE_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: requestIsHttps(req),
    maxAge: 0,
    path: "/",
  });
  return res;
}
