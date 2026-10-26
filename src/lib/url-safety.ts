/**
 * URL / fetch guards for SSRF and unsafe schemes.
 * Validate after DNS resolution and again on every redirect hop.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const BLOCKED_HOSTS = new Set(["localhost", "metadata.google.internal"]);

function ipv4ToInt(ip: string): number {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return -1;
  }
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function inCidr(ipInt: number, base: string, bits: number): boolean {
  const baseInt = ipv4ToInt(base);
  if (baseInt < 0) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

/** True when an IPv4/IPv6 literal is loopback, link-local, private, or otherwise non-public. */
export function isPrivateIp(ip: string): boolean {
  const v = ip.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (v === "::1" || v === "::" || v === "0:0:0:0:0:0:0:1") return true;
  if (v.includes(":")) {
    // IPv4-mapped IPv6
    const mapped = v.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
    if (mapped) return isPrivateIp(mapped[1]);
    if (v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe8") || v.startsWith("fe9")
      || v.startsWith("fea") || v.startsWith("feb")) return true;
    return false;
  }
  const n = ipv4ToInt(v);
  if (n < 0) return true;
  return (
    inCidr(n, "0.0.0.0", 8) ||
    inCidr(n, "10.0.0.0", 8) ||
    inCidr(n, "127.0.0.0", 8) ||
    inCidr(n, "169.254.0.0", 16) ||
    inCidr(n, "172.16.0.0", 12) ||
    inCidr(n, "192.168.0.0", 16) ||
    inCidr(n, "100.64.0.0", 10) ||
    inCidr(n, "192.0.0.0", 24) ||
    inCidr(n, "192.0.2.0", 24) ||
    inCidr(n, "198.51.100.0", 24) ||
    inCidr(n, "203.0.113.0", 24) ||
    inCidr(n, "224.0.0.0", 4) ||
    inCidr(n, "240.0.0.0", 4)
  );
}

/** Parse and require http(s) with no credentials or opaque local forms. */
export function parseHttpUrl(raw: string): URL | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password) return null;
  if (!u.hostname) return null;
  // Block bare IPs that are private before DNS.
  if (isIP(u.hostname) && isPrivateIp(u.hostname)) return null;
  if (BLOCKED_HOSTS.has(u.hostname.toLowerCase())) return null;
  return u;
}

/** Href-safe: only http(s) URLs; use at render time for stored links. */
export function safeHref(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const u = parseHttpUrl(raw);
  return u ? u.toString() : null;
}

/** Resolve hostname and reject if any address is non-public. */
export async function assertPublicHttpUrl(raw: string): Promise<URL> {
  const u = parseHttpUrl(raw);
  if (!u) throw new Error("url_not_allowed");
  if (isIP(u.hostname)) {
    if (isPrivateIp(u.hostname)) throw new Error("url_private");
    return u;
  }
  let addrs: { address: string }[];
  try {
    addrs = await lookup(u.hostname, { all: true, verbatim: true });
  } catch {
    throw new Error("url_dns_failed");
  }
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) {
    throw new Error("url_private");
  }
  return u;
}

export type SafeFetchOpts = {
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  method?: string;
};

/**
 * Fetch a public http(s) URL with redirect re-validation, streamed size cap,
 * and a hard timeout. Throws on policy violations; returns the Response for
 * callers that need headers (body already consumed into an ArrayBuffer when
 * maxBytes is set — use `safeFetchBuffer` for that).
 */
export async function safeFetchBuffer(
  raw: string,
  opts: SafeFetchOpts = {},
): Promise<{ url: string; status: number; headers: Headers; buffer: Buffer }> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
  const maxRedirects = opts.maxRedirects ?? 5;
  let current = raw;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const u = await assertPublicHttpUrl(current);
    const res = await fetch(u.toString(), {
      method: opts.method ?? "GET",
      headers: opts.headers,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get("location");
      if (!loc) throw new Error("redirect_missing");
      current = new URL(loc, u).toString();
      continue;
    }

    if (!res.body) {
      return { url: u.toString(), status: res.status, headers: res.headers, buffer: Buffer.alloc(0) };
    }

    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        try { reader.cancel(); } catch { /* ignore */ }
        throw new Error("body_too_large");
      }
      chunks.push(value);
    }
    return {
      url: u.toString(),
      status: res.status,
      headers: res.headers,
      buffer: Buffer.concat(chunks.map((c) => Buffer.from(c))),
    };
  }
  throw new Error("too_many_redirects");
}
