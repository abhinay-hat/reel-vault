import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authCookieValue, isValidAuthCookie } from "./passcode";

const ORIGINAL = process.env.APP_PASSCODE;

beforeEach(() => {
  process.env.APP_PASSCODE = "test-secret-pass";
});

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.APP_PASSCODE;
  else process.env.APP_PASSCODE = ORIGINAL;
});

describe("passcode cookie", () => {
  it("accepts HMAC of the configured passcode", async () => {
    const token = await authCookieValue("test-secret-pass");
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(await isValidAuthCookie(token)).toBe(true);
  });

  it("rejects the literal ok", async () => {
    expect(await isValidAuthCookie("ok")).toBe(false);
  });

  it("invalidates old cookies when passcode changes", async () => {
    const old = await authCookieValue("test-secret-pass");
    process.env.APP_PASSCODE = "changed-pass";
    expect(await isValidAuthCookie(old)).toBe(false);
    const next = await authCookieValue("changed-pass");
    expect(await isValidAuthCookie(next)).toBe(true);
  });
});
