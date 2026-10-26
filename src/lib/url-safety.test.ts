import { describe, expect, it, vi } from "vitest";
import {
  isPrivateIp,
  parseHttpUrl,
  safeHref,
  assertPublicHttpUrl,
  safeFetchBuffer,
  type PinnedTransport,
  type ResolveAllFn,
} from "./url-safety";

describe("isPrivateIp", () => {
  it("flags loopback, RFC1918, CGNAT, link-local, multicast", () => {
    expect(isPrivateIp("127.0.0.1")).toBe(true);
    expect(isPrivateIp("10.0.0.5")).toBe(true);
    expect(isPrivateIp("192.168.1.1")).toBe(true);
    expect(isPrivateIp("172.16.0.1")).toBe(true);
    expect(isPrivateIp("169.254.169.254")).toBe(true);
    expect(isPrivateIp("100.64.0.1")).toBe(true);
    expect(isPrivateIp("224.0.0.1")).toBe(true);
    expect(isPrivateIp("::1")).toBe(true);
    expect(isPrivateIp("fc00::1")).toBe(true);
    expect(isPrivateIp("fe80::1")).toBe(true);
    expect(isPrivateIp("ff02::1")).toBe(true);
  });

  it("flags IPv4-mapped IPv6 private addresses", () => {
    expect(isPrivateIp("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateIp("::ffff:10.0.0.1")).toBe(true);
    expect(isPrivateIp("::ffff:169.254.169.254")).toBe(true);
    expect(isPrivateIp("::ffff:7f00:1")).toBe(true); // hex form of 127.0.0.1
  });

  it("allows public addresses", () => {
    expect(isPrivateIp("8.8.8.8")).toBe(false);
    expect(isPrivateIp("1.1.1.1")).toBe(false);
    expect(isPrivateIp("::ffff:8.8.8.8")).toBe(false);
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

describe("assertPublicHttpUrl with mocked DNS", () => {
  it("rejects private IP literals without DNS", async () => {
    await expect(assertPublicHttpUrl("http://127.0.0.1/")).rejects.toThrow(/url_not_allowed|url_private/);
    await expect(assertPublicHttpUrl("http://169.254.169.254/latest")).rejects.toThrow();
    await expect(assertPublicHttpUrl("http://[::ffff:127.0.0.1]/")).rejects.toThrow();
  });

  it("rejects hostname that resolves to a private IP", async () => {
    const resolveAll: ResolveAllFn = async () => [{ address: "10.0.0.5", family: 4 }];
    await expect(
      assertPublicHttpUrl("https://evil.example/meta", resolveAll),
    ).rejects.toThrow("url_private");
  });

  it("rejects when any resolved address is private", async () => {
    const resolveAll: ResolveAllFn = async () => [
      { address: "8.8.8.8", family: 4 },
      { address: "192.168.0.1", family: 4 },
    ];
    await expect(assertPublicHttpUrl("https://mixed.example/", resolveAll)).rejects.toThrow(
      "url_private",
    );
  });

  it("allows hostname that resolves only to public IPs", async () => {
    const resolveAll: ResolveAllFn = async () => [{ address: "8.8.8.8", family: 4 }];
    const u = await assertPublicHttpUrl("https://cdn.example/x", resolveAll);
    expect(u.hostname).toBe("cdn.example");
  });
});

describe("safeFetchBuffer DNS pin + redirects", () => {
  it("rejects private literal before transport", async () => {
    const transport = vi.fn() as unknown as PinnedTransport;
    await expect(
      safeFetchBuffer("http://192.168.1.1/x", { transport, resolveAll: async () => [] }),
    ).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });

  it("rejects hostname resolving to private IP before transport", async () => {
    const transport = vi.fn() as unknown as PinnedTransport;
    const resolveAll: ResolveAllFn = async () => [{ address: "127.0.0.1", family: 4 }];
    await expect(
      safeFetchBuffer("https://rebind.example/a", { transport, resolveAll }),
    ).rejects.toThrow("url_private");
    expect(transport).not.toHaveBeenCalled();
  });

  it("rejects redirect to a private IP", async () => {
    const resolveAll: ResolveAllFn = async (host) => {
      if (host === "cdn.example") return [{ address: "8.8.8.8", family: 4 }];
      throw new Error("unexpected host " + host);
    };
    const transport: PinnedTransport = async (url, pinned) => {
      expect(url.hostname).toBe("cdn.example");
      expect(pinned.address).toBe("8.8.8.8");
      return {
        status: 302,
        headers: new Headers({ location: "http://127.0.0.1/secret" }),
        chunks: [],
      };
    };
    await expect(
      safeFetchBuffer("https://cdn.example/start", { resolveAll, transport }),
    ).rejects.toThrow();
  });

  it("rejects redirect to hostname that resolves private", async () => {
    const resolveAll: ResolveAllFn = async (host) => {
      if (host === "cdn.example") return [{ address: "8.8.8.8", family: 4 }];
      if (host === "internal.example") return [{ address: "10.0.0.9", family: 4 }];
      throw new Error("unexpected " + host);
    };
    let calls = 0;
    const transport: PinnedTransport = async () => {
      calls += 1;
      if (calls === 1) {
        return {
          status: 302,
          headers: new Headers({ location: "https://internal.example/x" }),
          chunks: [],
        };
      }
      throw new Error("should not fetch internal");
    };
    await expect(
      safeFetchBuffer("https://cdn.example/start", { resolveAll, transport }),
    ).rejects.toThrow("url_private");
    expect(calls).toBe(1);
  });

  it("pins connect to validated public IP and returns body", async () => {
    const resolveAll: ResolveAllFn = async () => [{ address: "1.1.1.1", family: 4 }];
    const transport: PinnedTransport = async (url, pinned, opts) => {
      expect(url.hostname).toBe("public.example");
      expect(pinned.address).toBe("1.1.1.1");
      expect(opts.maxBytes).toBeGreaterThan(0);
      return {
        status: 200,
        headers: new Headers({ "content-type": "text/plain" }),
        chunks: [new TextEncoder().encode("ok")],
      };
    };
    const res = await safeFetchBuffer("https://public.example/r", { resolveAll, transport });
    expect(res.status).toBe(200);
    expect(res.buffer.toString()).toBe("ok");
    expect(res.url).toContain("public.example");
  });

  it("rejects IPv4-mapped IPv6 private via resolve", async () => {
    const resolveAll: ResolveAllFn = async () => [
      { address: "::ffff:169.254.169.254", family: 6 },
    ];
    await expect(
      safeFetchBuffer("https://meta.example/", {
        resolveAll,
        transport: async () => {
          throw new Error("should not run");
        },
      }),
    ).rejects.toThrow("url_private");
  });
});
