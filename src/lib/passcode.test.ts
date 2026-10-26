import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mintAuthCookie,
  isValidAuthCookie,
  loginClientKey,
} from "./passcode";

const ORIGINAL = process.env.APP_PASSCODE;
const ORIGINAL_TTL = process.env.AUTH_TTL_SECONDS;
const ORIGINAL_TRUST = process.env.TRUST_PROXY;

beforeEach(() => {
  process.env.APP_PASSCODE = "test-secret-pass";
  delete process.env.AUTH_TTL_SECONDS;
  delete process.env.TRUST_PROXY;
});

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.APP_PASSCODE;
  else process.env.APP_PASSCODE = ORIGINAL;
  if (ORIGINAL_TTL === undefined) delete process.env.AUTH_TTL_SECONDS;
  else process.env.AUTH_TTL_SECONDS = ORIGINAL_TTL;
  if (ORIGINAL_TRUST === undefined) delete process.env.TRUST_PROXY;
  else process.env.TRUST_PROXY = ORIGINAL_TRUST;
});

describe("passcode cookie", () => {
  it("accepts a freshly minted v2 session", async () => {
    const { value, maxAge } = await mintAuthCookie("test-secret-pass");
    expect(value).toMatch(/^v2\.\d+\.\d+\.[0-9a-f]{64}$/);
    expect(maxAge).toBeGreaterThan(60);
    expect(await isValidAuthCookie(value)).toBe(true);
  });

  it("rejects the literal ok and legacy fixed HMAC shapes", async () => {
    expect(await isValidAuthCookie("ok")).toBe(false);
    expect(await isValidAuthCookie("a".repeat(64))).toBe(false);
  });

  it("rejects expired sessions", async () => {
    process.env.AUTH_TTL_SECONDS = "60";
    const past = Math.floor(Date.now() / 1000) - 120;
    const { value } = await mintAuthCookie("test-secret-pass", past);
    expect(await isValidAuthCookie(value)).toBe(false);
  });

  it("invalidates cookies when passcode changes", async () => {
    const { value: old } = await mintAuthCookie("test-secret-pass");
    process.env.APP_PASSCODE = "changed-pass";
    expect(await isValidAuthCookie(old)).toBe(false);
    const { value: next } = await mintAuthCookie("changed-pass");
    expect(await isValidAuthCookie(next)).toBe(true);
  });

  it("ignores X-Forwarded-For unless TRUST_PROXY=1", () => {
    const req = {
      headers: {
        get(name: string) {
          if (name === "x-forwarded-for") return "203.0.113.9";
          return null;
        },
      },
    };
    expect(loginClientKey(req)).toBe("local");
    process.env.TRUST_PROXY = "1";
    expect(loginClientKey(req)).toBe("203.0.113.9");
  });
});
