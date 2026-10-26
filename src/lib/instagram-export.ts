// Meta's JSON exports double-encode UTF-8: every UTF-8 byte is written as its
// own escaped code point (e.g. "ą" arrives as "Ä"). After JSON.parse
// that yields mojibake. Fix: re-pack code points <= 0xFF into bytes and decode
// as UTF-8. Strings containing real (> 0xFF) code points are left untouched.
export function fixMojibake(s: string): string {
  if (!/[\u0080-\u00ff]/.test(s)) return s;
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c > 0xff) return s; // genuine unicode, not byte-mojibake
    bytes[i] = c;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return s; // not valid UTF-8 byte sequence; keep original
  }
}

const str = (v: unknown): string | undefined =>
  typeof v === "string" ? fixMojibake(v) : undefined;

export interface SavedPost {
  url: string;
  author?: string;
}

interface ExportEntry {
  title?: unknown;
  string_map_data?: Record<string, { href?: unknown }>;
  string_list_data?: { href?: unknown }[];
}

function firstArray(data: Record<string, unknown>, key: string): ExportEntry[] {
  const direct = data[key];
  if (Array.isArray(direct)) return direct;
  // Key names in Meta exports are reconstructed/unstable; fall back to the
  // first array-valued top-level key.
  const any = Object.values(data).find(Array.isArray);
  return Array.isArray(any) ? any : [];
}

function isHttpHref(href: unknown): href is string {
  return typeof href === "string" && /^https?:\/\//i.test(href);
}

function entryHref(entry: ExportEntry): string | undefined {
  const fromMap = entry.string_map_data
    ? Object.values(entry.string_map_data).find((v) => isHttpHref(v?.href))?.href
    : undefined;
  if (isHttpHref(fromMap)) return fromMap;
  const fromList = entry.string_list_data?.find((v) => isHttpHref(v?.href))?.href;
  return isHttpHref(fromList) ? fromList : undefined;
}

export function parseSavedPosts(rawJson: string): SavedPost[] {
  try {
    const data = JSON.parse(rawJson);
    const out: SavedPost[] = [];
    for (const entry of firstArray(data, "saved_saved_media")) {
      const href = entryHref(entry);
      if (href) out.push({ url: href, author: str(entry.title) });
    }
    return out;
  } catch {
    return [];
  }
}

export interface LikedPost {
  url: string;
  author?: string;
}

export function parseLikedPosts(rawJson: string): LikedPost[] {
  try {
    const data = JSON.parse(rawJson);
    const out: LikedPost[] = [];
    for (const entry of firstArray(data, "likes_media_likes")) {
      const href = entryHref(entry);
      if (href) out.push({ url: href, author: str(entry.title) });
    }
    return out;
  } catch {
    return [];
  }
}

export interface ParsedMessage { externalId: string; sender: string; content?: string; sentAt: number; sharedUrl?: string; }
export interface ParsedThread { threadKey: string; title: string; participants: string[]; messages: ParsedMessage[]; }

export function parseInbox(rawJson: string): ParsedThread | null {
  try {
    const d = JSON.parse(rawJson);
    if (!Array.isArray(d.messages)) return null;
    const participants = Array.isArray(d.participants)
      ? d.participants.map((p: { name?: string }) => str(p?.name)).filter(Boolean) : [];
    const messages: ParsedMessage[] = d.messages.map((m: { sender_name?: string; timestamp_ms?: number; content?: string; share?: { link?: string }; }) => ({
      externalId: `${m.sender_name ?? "?"}:${m.timestamp_ms ?? 0}`,
      sender: str(m.sender_name) ?? "unknown",
      content: str(m.content),
      sentAt: typeof m.timestamp_ms === "number" ? m.timestamp_ms : 0,
      sharedUrl: isHttpHref(m.share?.link) ? m.share.link : undefined,
    }));
    return {
      threadKey: typeof d.thread_path === "string" ? d.thread_path : (str(d.title) ?? "thread"),
      title: str(d.title) ?? "Conversation",
      participants, messages,
    };
  } catch { return null; }
}
