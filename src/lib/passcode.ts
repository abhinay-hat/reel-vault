export const PASSCODE_COOKIE = "rv_auth";
/** Default session lifetime (7 days). Override with AUTH_TTL_SECONDS. */
export const DEFAULT_AUTH_TTL_SECONDS = 60 * 60 * 24 * 7;

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export function isValidPasscode(input: string): boolean {
  const expected = process.env.APP_PASSCODE;
  if (!expected || typeof input !== "string") return false;
  // Pad both sides to the same length so a length mismatch is not a free oracle.
  const enc = new TextEncoder();
  const a = enc.encode(input);
  const b = enc.encode(expected);
  const len = Math.max(a.length, b.length);
  let diff = a.length === b.length ? 0 : 1;
  for (let i = 0; i < len; i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

/** Constant-time compare for bearer tokens and similar secrets. */
export function timingSafeEqualString(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const aa = enc.encode(a);
  const bb = enc.encode(b);
  const len = Math.max(aa.length, bb.length);
  let diff = aa.length === bb.length ? 0 : 1;
  for (let i = 0; i < len; i++) {
    diff |= (aa[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

function authTtlSeconds(): number {
  const raw = process.env.AUTH_TTL_SECONDS;
  if (!raw) return DEFAULT_AUTH_TTL_SECONDS;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 60) return DEFAULT_AUTH_TTL_SECONDS;
  return Math.min(n, 60 * 60 * 24 * 365);
}

async function hmacHex(passcode: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passcode),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message),
  );
  return [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Mint a rotating session cookie: v2.<iat>.<exp>.<hmac>.
 * HMAC covers issued-at and expiry so a stolen cookie dies when exp passes,
 * and each login gets a fresh window (not a forever fixed token).
 */
export async function mintAuthCookie(
  passcode: string,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<{ value: string; maxAge: number }> {
  const ttl = authTtlSeconds();
  const iat = nowSec;
  const exp = nowSec + ttl;
  const sig = await hmacHex(passcode, `rv_auth:v2:${iat}:${exp}`);
  return { value: `v2.${iat}.${exp}.${sig}`, maxAge: ttl };
}

/** @deprecated Prefer mintAuthCookie; kept for tests of the HMAC helper. */
export async function authCookieValue(passcode: string): Promise<string> {
  const { value } = await mintAuthCookie(passcode);
  return value;
}

/** True when cookie is a valid, unexpired v2 HMAC session for APP_PASSCODE. */
export async function isValidAuthCookie(
  value: string | undefined,
): Promise<boolean> {
  const passcode = process.env.APP_PASSCODE;
  if (!passcode || !value) return false;
  const parts = value.split(".");
  if (parts.length !== 4 || parts[0] !== "v2") return false;
  const iat = Number.parseInt(parts[1]!, 10);
  const exp = Number.parseInt(parts[2]!, 10);
  const sig = parts[3]!;
  if (!Number.isFinite(iat) || !Number.isFinite(exp)) return false;
  if (!/^[0-9a-f]{64}$/.test(sig)) return false;
  const now = Math.floor(Date.now() / 1000);
  if (exp < now || iat > now + 60) return false;
  if (exp - iat > 60 * 60 * 24 * 366) return false;
  const want = await hmacHex(passcode, `rv_auth:v2:${iat}:${exp}`);
  return timingSafeEqual(sig, want);
}

/**
 * Client IP for login rate limiting. Ignore X-Forwarded-* unless TRUST_PROXY=1
 * so a remote caller cannot rotate spoofed headers to bypass the budget.
 */
export function loginClientKey(req: {
  headers: { get(name: string): string | null };
}): string {
  if (process.env.TRUST_PROXY === "1") {
    return (
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      req.headers.get("x-real-ip") ||
      "local"
    );
  }
  return "local";
}

/** Simple per-key sliding window for /api/login. */
const loginAttempts = new Map<string, number[]>();
const LOGIN_WINDOW_MS = 60_000;
const LOGIN_MAX = 20;

export function loginRateLimit(ip: string): boolean {
  const now = Date.now();
  const prev = (loginAttempts.get(ip) ?? []).filter((t) => now - t < LOGIN_WINDOW_MS);
  if (prev.length >= LOGIN_MAX) {
    loginAttempts.set(ip, prev);
    return false;
  }
  prev.push(now);
  loginAttempts.set(ip, prev);
  return true;
}

/** Whether the request arrived over HTTPS (direct or via trusted proxy). */
export function requestIsHttps(req: {
  nextUrl?: { protocol?: string };
  headers: { get(name: string): string | null };
}): boolean {
  if (req.nextUrl?.protocol === "https:") return true;
  if (process.env.TRUST_PROXY === "1") {
    const proto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
    if (proto === "https") return true;
  }
  return false;
}
