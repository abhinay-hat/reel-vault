import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { NextRequest } from "next/server";
import { mediaPath } from "@/lib/media";

const TYPE_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  heic: "image/heic",
  gif: "image/gif",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
};

/**
 * Serve one cached file from the local media directory.
 *
 * Filenames are content hashes written by `cacheMedia`, so they are immutable
 * and cache forever. The basename is re-derived here rather than trusted: a
 * request for `../../.env` must resolve inside the media directory or 404.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ file: string }> },
) {
  const { file } = await params;
  const safe = path.basename(file);
  if (safe !== file || !/^[a-f0-9]{8,64}\.[a-z0-9]{2,5}$/i.test(safe)) {
    return new Response("Not found", { status: 404 });
  }

  const full = mediaPath(safe);
  let size: number;
  try {
    const s = await stat(full);
    if (!s.isFile()) return new Response("Not found", { status: 404 });
    size = s.size;
  } catch {
    return new Response("Not found", { status: 404 });
  }

  const ext = safe.split(".").pop()?.toLowerCase() ?? "";
  const type = TYPE_BY_EXT[ext] ?? "application/octet-stream";

  // Byte ranges. Safari will not play a <video> that answers 200 to its
  // opening `Range: bytes=0-1` probe, and no browser can scrub without them,
  // so a range request is served as a 206 over just that slice.
  const range = _req.headers.get("range");
  const match = range?.match(/^bytes=(\d*)-(\d*)$/);
  if (match && size > 0) {
    const [, rawStart, rawEnd] = match;
    let start = rawStart ? Number(rawStart) : 0;
    let end = rawEnd ? Number(rawEnd) : size - 1;
    if (!rawStart && rawEnd) {
      // "bytes=-500" means the final 500 bytes.
      start = Math.max(0, size - Number(rawEnd));
      end = size - 1;
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
      return new Response("Range not satisfiable", {
        status: 416,
        headers: { "Content-Range": `bytes */${size}` },
      });
    }
    end = Math.min(end, size - 1);
    const body = createReadStream(full, { start, end }) as unknown as ReadableStream;
    return new Response(body, {
      status: 206,
      headers: {
        "Content-Type": type,
        "Content-Length": String(end - start + 1),
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Accept-Ranges": "bytes",
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  }

  const stream = createReadStream(full) as unknown as ReadableStream;

  return new Response(stream, {
    headers: {
      "Content-Type": type,
      "Content-Length": String(size),
      "Accept-Ranges": "bytes",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}
