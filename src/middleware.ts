import { NextRequest, NextResponse } from "next/server";
import { PASSCODE_COOKIE } from "@/lib/passcode";

export function middleware(req: NextRequest) {
  const authed = req.cookies.get(PASSCODE_COOKIE)?.value === "ok";
  const isLogin =
    req.nextUrl.pathname === "/login" ||
    req.nextUrl.pathname === "/api/login";
  if (!authed && !isLogin) {
    return NextResponse.redirect(new URL("/login", req.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|manifest.json).*)"],
};
