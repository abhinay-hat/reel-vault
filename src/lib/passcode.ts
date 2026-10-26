export const PASSCODE_COOKIE = "rv_auth";
const AUTH_MESSAGE = "rv_auth:v1";

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
  // Compare against the real secret using the longer length buffer.
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

/** HMAC-SHA256(key=APP_PASSCODE, message="rv_auth:v1") as lowercase hex. */
export async function authCookieValue(passcode: string): Promise<string> {
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
    new TextEncoder().encode(AUTH_MESSAGE),
  );
  return [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** True when cookie matches HMAC of the configured APP_PASSCODE. */
export async function isValidAuthCookie(
  value: string | undefined,
): Promise<boolean> {
  const passcode = process.env.APP_PASSCODE;
  if (!passcode || !value) return false;
  const want = await authCookieValue(passcode);
  return timingSafeEqual(value, want);
}

/** Simple per-IP sliding window for /api/login. */
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
