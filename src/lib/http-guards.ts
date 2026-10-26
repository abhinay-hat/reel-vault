/**
 * Host / Origin checks (DNS-rebinding defense) and baseline security headers.
 */
import type { Context, Next } from "hono";

const DEFAULT_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function stripPort(host: string): string {
  // IPv6 in brackets: [::1]:3210
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    return end >= 0 ? host.slice(0, end + 1) : host;
  }
  const i = host.lastIndexOf(":");
  return i > 0 ? host.slice(0, i) : host;
}

/** Hostnames this process will answer for. */
export function allowedHosts(): Set<string> {
  const set = new Set(DEFAULT_HOSTS);
  const extra = (process.env.ALLOWED_HOSTS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  for (const h of extra) set.add(h);
  const bind = (process.env.HOST ?? "127.0.0.1").trim().toLowerCase();
  if (bind && bind !== "0.0.0.0" && bind !== "::") set.add(bind);
  return set;
}

/** True when HOST would expose the server beyond loopback. */
export function isLanBind(host: string | undefined): boolean {
  const h = (host ?? "127.0.0.1").trim().toLowerCase();
  if (!h || h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "[::1]") {
    return false;
  }
  return true;
}

export function hostAllowed(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  const host = stripPort(hostHeader.trim().toLowerCase());
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const allowed = allowedHosts();
  return allowed.has(host) || allowed.has(bare);
}

export function originAllowed(origin: string | undefined, hostHeader: string | undefined): boolean {
  if (!origin) return true; // non-browser clients (Shortcut, curl) omit Origin
  try {
    const u = new URL(origin);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    const originHost = u.host.toLowerCase();
    const reqHost = (hostHeader ?? "").trim().toLowerCase();
    // Prefer exact Host match; also accept allowlist.
    if (reqHost && originHost === reqHost) return true;
    return hostAllowed(u.host);
  } catch {
    return false;
  }
}

const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy":
    "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

export async function securityMiddleware(c: Context, next: Next) {
  const host = c.req.header("host");
  if (!hostAllowed(host)) {
    return c.json({ error: "bad_host" }, 400);
  }
  const method = c.req.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
    if (!originAllowed(c.req.header("origin"), host)) {
      return c.json({ error: "bad_origin" }, 403);
    }
  }
  await next();
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
    if (!c.res.headers.has(k)) c.res.headers.set(k, v);
  }
}
