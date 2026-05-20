export const PASSCODE_COOKIE = "rv_auth";

export function isValidPasscode(input: string): boolean {
  const expected = process.env.APP_PASSCODE;
  return !!expected && input === expected;
}
