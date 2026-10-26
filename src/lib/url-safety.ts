/**
 * Server-side URL fetch guards for SSRF.
 * Resolve once, validate every address, connect only to a validated IP
 * (custom lookup keeps Host/SNI), and re-validate each redirect hop.
 *
 * Pure policy helpers (safeHref, parseHttpUrl, isPrivateIp) live in url-policy.ts
 * so the browser bundle does not pull in node:http / dns.
 */
import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import type { LookupFunction } from "node:net";
import { isIpLiteral, isPrivateIp, parseHttpUrl } from "./url-policy";

export { isPrivateIp, parseHttpUrl, safeHref, isIpLiteral } from "./url-policy";

export type ResolvedAddress = { address: string; family: number };

export type ResolveAllFn = (hostname: string) => Promise<ResolvedAddress[]>;

const defaultResolveAll: ResolveAllFn = async (hostname) => {
  const addrs = await lookup(hostname, { all: true, verbatim: true });
  return addrs.map((a) => ({ address: a.address, family: a.family }));
};

/** Resolve hostname and reject if any address is non-public. Returns validated addresses. */
export async function resolvePublicAddresses(
  hostname: string,
  resolveAll: ResolveAllFn = defaultResolveAll,
): Promise<ResolvedAddress[]> {
  if (isIpLiteral(hostname)) {
    if (isPrivateIp(hostname)) throw new Error("url_private");
    return [{ address: hostname, family: hostname.includes(":") ? 6 : 4 }];
  }
  let addrs: ResolvedAddress[];
  try {
    addrs = await resolveAll(hostname);
  } catch (e) {
    if (e instanceof Error && (e.message === "url_private" || e.message === "url_dns_failed")) {
      throw e;
    }
    throw new Error("url_dns_failed");
  }
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) {
    throw new Error("url_private");
  }
  return addrs;
}

/** Resolve hostname and reject if any address is non-public. */
export async function assertPublicHttpUrl(
  raw: string,
  resolveAll: ResolveAllFn = defaultResolveAll,
): Promise<URL> {
  const u = parseHttpUrl(raw);
  if (!u) throw new Error("url_not_allowed");
  await resolvePublicAddresses(u.hostname, resolveAll);
  return u;
}

export type SafeFetchOpts = {
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  method?: string;
  /** Inject DNS resolution (tests). */
  resolveAll?: ResolveAllFn;
  /** Inject transport (tests). */
  transport?: PinnedTransport;
};

export type PinnedTransportResult = {
  status: number;
  headers: Headers;
  chunks: Uint8Array[];
};

export type PinnedTransport = (
  url: URL,
  pinned: ResolvedAddress,
  opts: {
    method: string;
    headers?: Record<string, string>;
    timeoutMs: number;
    maxBytes: number;
  },
) => Promise<PinnedTransportResult>;

function headersFromNode(raw: http.IncomingHttpHeaders): Headers {
  const h = new Headers();
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) h.append(key, v);
    } else {
      h.set(key, value);
    }
  }
  return h;
}

/** Connect only to a validated IP while keeping Host/SNI from the URL hostname. */
export const defaultPinnedTransport: PinnedTransport = (url, pinned, opts) => {
  const lib = url.protocol === "https:" ? https : http;
  const pinnedLookup: LookupFunction = ((_hostname, options, callback) => {
    const cb = callback as (
      err: Error | null,
      address: string | ResolvedAddress[],
      family?: number,
    ) => void;
    if (options && (options as { all?: boolean }).all) {
      cb(null, [{ address: pinned.address, family: pinned.family }]);
    } else {
      cb(null, pinned.address, pinned.family);
    }
  }) as LookupFunction;

  return new Promise((resolve, reject) => {
    const req = lib.request(
      url,
      {
        method: opts.method,
        headers: opts.headers,
        timeout: opts.timeoutMs,
        lookup: pinnedLookup,
        servername: url.protocol === "https:" ? url.hostname : undefined,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const headers = headersFromNode(res.headers);
        if ([301, 302, 303, 307, 308].includes(status)) {
          res.resume();
          resolve({ status, headers, chunks: [] });
          return;
        }
        const chunks: Uint8Array[] = [];
        let total = 0;
        res.on("data", (chunk: Buffer) => {
          total += chunk.byteLength;
          if (total > opts.maxBytes) {
            res.destroy();
            reject(new Error("body_too_large"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          resolve({ status, headers, chunks });
        });
        res.on("error", reject);
      },
    );
    req.on("timeout", () => {
      req.destroy(new Error("timeout"));
    });
    req.on("error", reject);
    req.end();
  });
};

/**
 * Fetch a public http(s) URL with DNS pin (no rebinding TOCTOU), redirect
 * re-validation, streamed size cap, and a hard timeout.
 */
export async function safeFetchBuffer(
  raw: string,
  opts: SafeFetchOpts = {},
): Promise<{ url: string; status: number; headers: Headers; buffer: Buffer }> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
  const maxRedirects = opts.maxRedirects ?? 5;
  const resolveAll = opts.resolveAll ?? defaultResolveAll;
  const transport = opts.transport ?? defaultPinnedTransport;
  let current = raw;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const u = parseHttpUrl(current);
    if (!u) throw new Error("url_not_allowed");
    const addrs = await resolvePublicAddresses(u.hostname, resolveAll);
    const pinned = addrs.find((a) => a.family === 4) ?? addrs[0];

    const res = await transport(u, pinned, {
      method: opts.method ?? "GET",
      headers: opts.headers,
      timeoutMs,
      maxBytes,
    });

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get("location");
      if (!loc) throw new Error("redirect_missing");
      current = new URL(loc, u).toString();
      continue;
    }

    const out = res.chunks.map((c) => Buffer.from(c));
    return {
      url: u.toString(),
      status: res.status,
      headers: res.headers,
      buffer: out.length ? Buffer.concat(out) : Buffer.alloc(0),
    };
  }
  throw new Error("too_many_redirects");
}
