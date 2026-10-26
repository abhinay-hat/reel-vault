import { unzipSync, strFromU8 } from "fflate";
import { Connector, IngestResult } from "./types";
import { parseSavedPosts, parseLikedPosts, parseInbox } from "../instagram-export";
import { detectSource } from "../metadata";
import { upsertItem, upsertConversation, insertMessage } from "../db";
import { parseHttpUrl } from "../url-safety";

const MAX_ZIP_ENTRIES = 5_000;
const MAX_ENTRY_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_UNCOMPRESSED = 200 * 1024 * 1024;

function safeUrl(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const u = parseHttpUrl(raw);
  return u ? u.toString() : null;
}

export class ExportConnector implements Connector {
  name = "instagram-export";
  async ingest(input: ArrayBuffer): Promise<IngestResult> {
    let files: Record<string, Uint8Array>;
    try {
      files = unzipSync(new Uint8Array(input), {
        filter(file) {
          return file.originalSize <= MAX_ENTRY_BYTES;
        },
      });
    } catch {
      throw new Error("invalid_or_oversized_zip");
    }
    const entries = Object.entries(files);
    if (entries.length > MAX_ZIP_ENTRIES) {
      throw new Error("zip_too_many_files");
    }
    let total = 0;
    for (const [, bytes] of entries) {
      total += bytes.byteLength;
      if (total > MAX_TOTAL_UNCOMPRESSED) throw new Error("zip_too_large");
    }

    const res: IngestResult = { itemsAdded: 0, conversationsAdded: 0, messagesAdded: 0, skipped: 0 };
    for (const [path, bytes] of entries) {
      try {
        if (/saved_posts\.json$/i.test(path)) {
          for (const p of parseSavedPosts(strFromU8(bytes))) {
            const url = safeUrl(p.url);
            if (!url) { res.skipped++; continue; }
            await upsertItem({ url, source: detectSource(url),
              title: p.author ? `Saved from ${p.author}` : "Saved reel",
              author: p.author ?? null, thumbnail: null, summary: null,
              category: "Imported", tags: [], notes: null, origin: "saved" });
            res.itemsAdded++;
          }
        } else if (/liked_posts\.json$/i.test(path)) {
          for (const p of parseLikedPosts(strFromU8(bytes))) {
            const url = safeUrl(p.url);
            if (!url) { res.skipped++; continue; }
            await upsertItem({ url, source: detectSource(url),
              title: p.author ? `Liked from ${p.author}` : "Liked post",
              author: p.author ?? null, thumbnail: null, summary: null,
              category: "Liked", tags: [], notes: null, origin: "saved" });
            res.itemsAdded++;
          }
        } else if (/messages\/inbox\/.+\/message_\d+\.json$/i.test(path)) {
          const t = parseInbox(strFromU8(bytes));
          if (!t) { res.skipped++; continue; }
          const convId = await upsertConversation({
            thread_key: t.threadKey, title: t.title, participants: t.participants,
            last_message_at: t.messages.length ? new Date(Math.max(...t.messages.map(m => m.sentAt))).toISOString() : null,
          });
          res.conversationsAdded++;
          for (const m of t.messages) {
            const shared = safeUrl(m.sharedUrl);
            const inserted = await insertMessage({
              conversation_id: convId, external_id: m.externalId, sender: m.sender,
              content: m.content ?? null, sent_at: new Date(m.sentAt).toISOString(),
              shared_url: shared,
            });
            if (inserted) res.messagesAdded++;
            if (shared) {
              await upsertItem({ url: shared, source: detectSource(shared),
                title: `Shared by ${m.sender}`, author: m.sender, thumbnail: null,
                summary: null, category: "Shared in DMs", tags: [], notes: null, origin: "dm_shared" })
                .then(() => { res.itemsAdded++; }).catch(() => {});
            }
          }
        }
      } catch { res.skipped++; }
    }
    return res;
  }
}
