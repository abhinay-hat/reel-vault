import { NextRequest, NextResponse } from "next/server";
import { PASSCODE_COOKIE, isValidAuthCookie } from "@/lib/passcode";

export async function middleware(req: NextRequest) {
  // No APP_PASSCODE set -> the gate is disabled entirely.
  if (!process.env.APP_PASSCODE) {
    return NextResponse.next();
  }
  const cookie = req.cookies.get(PASSCODE_COOKIE)?.value;
  const authed = await isValidAuthCookie(cookie);
  const isLogin =
    req.nextUrl.pathname === "/login" ||
    req.nextUrl.pathname === "/api/login" ||
    req.nextUrl.pathname === "/api/share"; // bearer-token auth, not cookie
  if (!authed && !isLogin) {
    return NextResponse.redirect(new URL("/login", req.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|manifest.json).*)"],
};
