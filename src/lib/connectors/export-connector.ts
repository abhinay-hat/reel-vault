import { unzipSync, strFromU8 } from "fflate";
import { Connector, IngestResult } from "./types";
import { parseSavedPosts, parseLikedPosts, parseInbox } from "../instagram-export";
import { detectSource } from "../metadata";
import { upsertItem, upsertConversation, insertMessage } from "../db";

export class ExportConnector implements Connector {
  name = "instagram-export";
  async ingest(input: ArrayBuffer): Promise<IngestResult> {
    const files = unzipSync(new Uint8Array(input));
    const res: IngestResult = { itemsAdded: 0, conversationsAdded: 0, messagesAdded: 0, skipped: 0 };
    for (const [path, bytes] of Object.entries(files)) {
      try {
        if (/saved_posts\.json$/i.test(path)) {
          for (const p of parseSavedPosts(strFromU8(bytes))) {
            await upsertItem({ url: p.url, source: detectSource(p.url),
              title: p.author ? `Saved from ${p.author}` : "Saved reel",
              author: p.author ?? null, thumbnail: null, summary: null,
              category: "Imported", tags: [], notes: null, origin: "saved" });
            res.itemsAdded++;
          }
        } else if (/liked_posts\.json$/i.test(path)) {
          for (const p of parseLikedPosts(strFromU8(bytes))) {
            await upsertItem({ url: p.url, source: detectSource(p.url),
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
            const inserted = await insertMessage({
              conversation_id: convId, external_id: m.externalId, sender: m.sender,
              content: m.content ?? null, sent_at: new Date(m.sentAt).toISOString(),
              shared_url: m.sharedUrl ?? null,
            });
            if (inserted) res.messagesAdded++;
            if (m.sharedUrl) {
              await upsertItem({ url: m.sharedUrl, source: detectSource(m.sharedUrl),
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
