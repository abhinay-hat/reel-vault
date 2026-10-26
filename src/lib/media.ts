import { createHash } from "node:crypto";
import { mkdir, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { safeFetchBuffer } from "./url-safety";

/**
 * Local media cache.
 *
 * Instagram serves thumbnails and videos from a signed CDN whose URLs carry an
 * `oe=` expiry. Storing that URL and rendering it later is a bet that the user
 * looks at the item before the signature dies — a bet this vault lost for all
 * 198 of its first items, which went dead about three weeks after import.
 *
 * A local-first archive has to hold the bytes. Media is copied here on ingest;
 * the remote URL survives only as the source to re-fetch from.
 */

const MEDIA_DIR =
  process.env.REEL_VAULT_MEDIA ??
  path.join(path.dirname(process.env.REEL_VAULT_DB ?? "data/reel-vault.db"), "media");

/** Refuse anything that is not an image or video, and anything implausibly large. */
const MAX_BYTES = 25 * 1024 * 1024;
// A reel is minutes of video, not a thumbnail: 25MB rejected the longer ones
// outright, which is one reason nothing was ever playable.
const MAX_VIDEO_BYTES = 250 * 1024 * 1024;

const EXT_BY_TYPE: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
};

export function mediaDir(): string {
  return MEDIA_DIR;
}

export function mediaPath(file: string): string {
  // Basename only: a stored filename must never escape the media directory.
  return path.join(MEDIA_DIR, path.basename(file));
}

export async function isCached(file: string | null | undefined): Promise<boolean> {
  if (!file) return false;
  try {
    await access(mediaPath(file));
    return true;
  } catch {
    return false;
  }
}

/**
 * Download one remote URL into the media directory.
 *
 * Returns the stored filename, or null when the fetch fails — an expired or
 * blocked URL is an expected outcome here, not an error worth throwing.
 */
export async function cacheMedia(
  url: string | null | undefined,
  kind: "thumb" | "video",
): Promise<string | null> {
  if (!url) return null;

  const cap = kind === "video" ? MAX_VIDEO_BYTES : MAX_BYTES;
  try {
    const { status, headers, buffer } = await safeFetchBuffer(url, {
      headers: {
        // Instagram's CDN rejects requests with no UA and no referer.
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
        Referer: "https://www.instagram.com/",
        Accept: kind === "video" ? "video/*,*/*" : "image/avif,image/webp,image/*,*/*",
      },
      // A thumbnail that takes 20s is broken; a video that takes 20s is normal.
      timeoutMs: kind === "video" ? 120_000 : 20_000,
      maxBytes: cap,
    });
    if (status < 200 || status >= 300) return null;

    const type = (headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    const ext = EXT_BY_TYPE[type];
    if (!ext) return null;
    if (buffer.byteLength === 0) return null;

    // Content-addressed: the same picture shared into two threads is stored once.
    const name = `${createHash("sha256").update(buffer).digest("hex").slice(0, 32)}.${ext}`;

    await mkdir(MEDIA_DIR, { recursive: true });
    await writeFile(mediaPath(name), buffer);
    return name;
  } catch {
    return null;
  }
}

/** True when a signed Instagram URL has already passed its `oe=` expiry. */
export function isExpired(url: string | null | undefined): boolean {
  if (!url) return false;
  const m = url.match(/[?&]oe=([0-9A-Fa-f]+)/);
  if (!m) return false;
  const expiry = parseInt(m[1], 16) * 1000;
  return Number.isFinite(expiry) && expiry < Date.now();
}
