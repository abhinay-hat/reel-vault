export const PASSCODE_COOKIE = "rv_auth";
const AUTH_MESSAGE = "rv_auth:v1";

export function isValidPasscode(input: string): boolean {
  const expected = process.env.APP_PASSCODE;
  return !!expected && input === expected;
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

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
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
