// Server-side client for the local instagrapi sidecar + mapper that stores
// gathered records into the local SQLite vault.
import {
  upsertItem,
  upsertConversation,
  insertMessage,
  type NewItem,
} from "./db";
import { cacheMedia } from "./media";
import { parseHttpUrl } from "./url-safety";

function httpUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const u = parseHttpUrl(raw);
  return u ? u.toString() : null;
}

export const IG_BRIDGE_URL = process.env.IG_BRIDGE_URL ?? "http://127.0.0.1:8765";

export async function bridge(path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(`${IG_BRIDGE_URL}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    cache: "no-store",
  });
  return res.json();
}

/**
 * Best-effort: ask the markitdown sidecar (`POST /convert {url}`) to convert a
 * url to markdown. Returns undefined on any failure (bridge down, ok:false, bad
 * shape) so enrichment can fall back to title/notes without breaking.
 */
export async function convertToMarkdown(url: string): Promise<string | undefined> {
  try {
    if (!httpUrl(url)) return undefined;
    const r = await bridge("/convert", { method: "POST", body: JSON.stringify({ url }) });
    if (
      r && typeof r === "object" &&
      (r as { ok?: unknown }).ok === true &&
      typeof (r as { markdown?: unknown }).markdown === "string"
    ) {
      return (r as { markdown: string }).markdown;
    }
  } catch { /* bridge unreachable */ }
  return undefined;
}

export interface GatheredItem {
  type: "reel" | "post" | "dm_share" | "dm_link" | "dm_text" | "article";
  permalink?: string | null;
  url?: string | null;
  caption_text?: string | null;
  title?: string | null;
  ig_title?: string | null;
  author?: string | null;
  from?: string | null;
  thumbnail_url?: string | null;
  preview_url?: string | null;
  // The sidecar has always sent this (main.py) and the mapper always dropped it,
  // which is why no reel in the vault has ever had a playable video.
  video_url?: string | null;
  /** Sender's handle when the bridge could resolve it, else their numeric id. */
  from_id?: string | null;
  thread_id?: string | null;
  thread_title?: string | null;
  text?: string | null;
  taken_at?: string | null;
  timestamp?: string | null;
}

export interface StoreResult {
  items: number;
  conversations: number;
  messages: number;
  skipped: number;
}

/** Map gathered sidecar records into items/conversations/messages. */
export async function storeGathered(items: GatheredItem[]): Promise<StoreResult> {
  const res: StoreResult = { items: 0, conversations: 0, messages: 0, skipped: 0 };
  const convCache = new Map<string, string>(); // thread_id -> conversation id

  async function ensureConv(threadId: string, title?: string | null, who?: string | null): Promise<string> {
    const cached = convCache.get(threadId);
    if (cached) return cached;
    const id = await upsertConversation({
      thread_key: `ig:${threadId}`,
      title: title || who || "Conversation",
      participants: who ? [who] : [],
      last_message_at: new Date().toISOString(),
    });
    convCache.set(threadId, id);
    res.conversations++;
    return id;
  }

  for (const g of items) {
    try {
      if (g.type === "reel" || g.type === "post") {
        const url = httpUrl(g.permalink ?? g.url);
        if (!url) { res.skipped++; continue; }
        const item: NewItem = {
          url, source: "instagram",
          title: g.caption_text?.slice(0, 120) || (g.type === "reel" ? "Saved reel" : "Saved post"),
          author: g.author ?? null, thumbnail: g.thumbnail_url ?? null, summary: null,
          category: g.type === "reel" ? "Reels" : "Saved", tags: [], notes: null, origin: "saved",
          created_at: g.taken_at ?? undefined,
          video: g.video_url ?? null,
          // Copy the bytes now, while the signed URL is still valid. Doing this
          // at read time instead is what left the first 198 items pointing at
          // dead links.
          media_file: await cacheMedia(g.thumbnail_url, "thumb"),
        };
        await upsertItem(item);
        res.items++;
      } else if (g.type === "dm_share") {
        const url = httpUrl(g.permalink ?? g.url);
        const threadId = g.thread_id ?? "unknown";
        const convId = await ensureConv(threadId, g.thread_title, g.from);
        const inserted = await insertMessage({
          conversation_id: convId,
          external_id: `${g.from_id ?? g.from ?? "?"}:${g.timestamp ?? ""}:${url ?? ""}`,
          sender: g.from ?? "unknown", content: g.title ?? null,
          sent_at: g.timestamp ?? new Date().toISOString(), shared_url: url,
        });
        if (inserted) res.messages++;
        if (url) {
          // A shared reel has two people: whoever posted it and whoever sent
          // it. The card is about the reel, so the caption is its title and the
          // original poster is its author; the sender is recorded on the message.
          const thumb = g.thumbnail_url ?? g.preview_url ?? null;
          await upsertItem({
            url, source: "instagram", title: g.title?.slice(0, 120) || `Shared by ${g.from ?? "someone"}`,
            author: g.author ?? g.from ?? null, thumbnail: thumb, summary: null,
            category: "Shared in DMs", tags: [], notes: null, origin: "dm_shared",
            // Prefer the reel's own date; fall back to when it was sent.
            created_at: g.taken_at ?? g.timestamp ?? undefined,
            video: g.video_url ?? null,
            media_file: await cacheMedia(thumb, "thumb"),
          });
          res.items++;
        }
      } else if (g.type === "dm_link" || g.type === "article") {
        const url = httpUrl(g.url ?? g.permalink);
        if (!url) { res.skipped++; continue; }
        await upsertItem({
          url, source: "article", title: g.ig_title || g.title || url,
          author: g.from ?? null, thumbnail: null, summary: null,
          category: "Articles", tags: [], notes: null, origin: "dm_shared",
          created_at: g.timestamp ?? undefined,
        });
        res.items++;
        if (g.thread_id) {
          const convId = await ensureConv(g.thread_id, g.thread_title, g.from);
          const inserted = await insertMessage({
            conversation_id: convId,
            external_id: `${g.from_id ?? g.from ?? "?"}:${g.timestamp ?? ""}:${url}`,
            sender: g.from ?? "unknown", content: g.ig_title ?? null,
            sent_at: g.timestamp ?? new Date().toISOString(), shared_url: url,
          });
          if (inserted) res.messages++;
        }
      } else if (g.type === "dm_text") {
        const threadId = g.thread_id ?? "unknown";
        const convId = await ensureConv(threadId, g.thread_title, g.from);
        const inserted = await insertMessage({
          conversation_id: convId,
          external_id: `${g.from_id ?? g.from ?? "?"}:${g.timestamp ?? ""}:text`,
          sender: g.from ?? "unknown", content: g.text ?? null,
          sent_at: g.timestamp ?? new Date().toISOString(), shared_url: null,
        });
        if (inserted) res.messages++;
      } else {
        res.skipped++;
      }
    } catch {
      res.skipped++;
    }
  }
  return res;
}
