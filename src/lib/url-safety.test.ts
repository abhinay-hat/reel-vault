import { describe, expect, it } from "vitest";
import { isPrivateIp, parseHttpUrl, safeHref } from "./url-safety";

describe("isPrivateIp", () => {
  it("flags loopback and RFC1918", () => {
    expect(isPrivateIp("127.0.0.1")).toBe(true);
    expect(isPrivateIp("10.0.0.5")).toBe(true);
    expect(isPrivateIp("192.168.1.1")).toBe(true);
    expect(isPrivateIp("172.16.0.1")).toBe(true);
    expect(isPrivateIp("169.254.169.254")).toBe(true);
    expect(isPrivateIp("::1")).toBe(true);
  });
  it("allows public addresses", () => {
    expect(isPrivateIp("8.8.8.8")).toBe(false);
    expect(isPrivateIp("1.1.1.1")).toBe(false);
  });
});

describe("parseHttpUrl / safeHref", () => {
  it("accepts http(s) only", () => {
    expect(parseHttpUrl("https://example.com/a")?.hostname).toBe("example.com");
    expect(parseHttpUrl("file:///etc/passwd")).toBeNull();
    expect(parseHttpUrl("http://127.0.0.1/x")).toBeNull();
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("https://instagram.com/p/x")).toMatch(/^https:/);
  });
});
