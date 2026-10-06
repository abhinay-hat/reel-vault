// Local SQLite data layer (node:sqlite, built into Node 24).
// This is the single source of truth for all persisted data; server
// components, actions, and connectors talk to the vault only through here.
//
// node:sqlite is loaded at runtime via process.getBuiltinModule instead of a
// static import: Turbopack's externalization shim for this experimental
// builtin breaks in ESM server chunks ("require is not defined").
import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { isExpired } from "@/lib/media";
// Type-only: erased at compile time, so the pure ai.ts stays free of any
// dependency on this module and its node:sqlite import.
import type { EntityKind } from "@/lib/ai";

// Node emits a one-time "SQLite is an experimental feature" ExperimentalWarning
// when node:sqlite first loads. It is expected here and harmless, but Next's dev
// overlay surfaces process warnings as console errors. Swallow only that exact
// message; every other warning passes through untouched.
let _warningPatched = false;
function silenceSqliteExperimentalWarning(): void {
  if (_warningPatched) return;
  _warningPatched = true;
  const orig = process.emitWarning.bind(process);
  process.emitWarning = ((warning: unknown, ...rest: unknown[]) => {
    const text =
      typeof warning === "string" ? warning : (warning as Error)?.message ?? "";
    if (text.includes("SQLite is an experimental feature")) return;
    return (orig as (...a: unknown[]) => void)(warning, ...rest);
  }) as typeof process.emitWarning;
}

function loadSqlite(): { DatabaseSync: typeof DatabaseSync } {
  const get = (process as unknown as {
    getBuiltinModule?: (id: string) => unknown;
  }).getBuiltinModule;
  if (!get) {
    throw new Error("node:sqlite requires Node 22.3+ (Node 24 recommended).");
  }
  silenceSqliteExperimentalWarning();
  return get("node:sqlite") as { DatabaseSync: typeof DatabaseSync };
}

const DB_PATH = process.env.REEL_VAULT_DB ?? path.join(process.cwd(), "data", "reel-vault.db");

let _db: DatabaseSync | null = null;

function db(): DatabaseSync {
  if (_db) return _db;
  mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const { DatabaseSync: DB } = loadSqlite();
  const d = new DB(DB_PATH);
  // pipeline/extract.py writes the same file; wait instead of SQLITE_BUSY.
  d.exec("pragma busy_timeout = 30000");
  d.exec(`
    create table if not exists items (
      id text primary key,
      url text unique not null,
      source text not null,
      title text not null,
      author text,
      thumbnail text,
      summary text,
      category text not null default 'Uncategorized',
      tags text not null default '[]',
      notes text,
      origin text not null default 'saved',
      created_at text not null
    );
    create table if not exists conversations (
      id text primary key,
      thread_key text unique not null,
      title text not null,
      participants text not null default '[]',
      last_message_at text,
      created_at text not null
    );
    create table if not exists messages (
      id text primary key,
      conversation_id text not null,
      external_id text not null,
      sender text not null,
      content text,
      sent_at text not null,
      shared_url text,
      unique (conversation_id, external_id)
    );
    create table if not exists sync_runs (
      id text primary key,
      started_at text not null,
      finished_at text not null,
      status text not null,
      items integer not null default 0,
      conversations integer not null default 0,
      messages integer not null default 0,
      skipped integer not null default 0,
      error text
    );
    create index if not exists sync_runs_started_idx on sync_runs(started_at desc);
    create index if not exists items_category_idx on items(category);
    create index if not exists items_created_idx on items(created_at desc);
    create index if not exists messages_conv_idx on messages(conversation_id, sent_at);
    create index if not exists conv_last_idx on conversations(last_message_at desc);
  `);
  // Migration: added_at records when an item entered the vault, so the home view
  // sorts newest-added first, independent of the reel's original Instagram date.
  try {
    d.exec("alter table items add column added_at text not null default ''");
  } catch {
    /* column already exists */
  }
  d.exec("update items set added_at = created_at where added_at is null or added_at = ''");
  d.exec("create index if not exists items_added_idx on items(added_at desc)");

  // Migration: Instagram's CDN URLs are signed and expire (the first 198 items
  // all went dead ~3 weeks after import). A local archive cannot depend on
  // someone else's expiring link, so media is copied onto this machine and the
  // remote URL is kept only as the re-fetch source.
  //   media_file — filename under data/media, or null when not cached yet
  //   video      — remote video URL from the sidecar, cached the same way
  // Migration: the extracted *content* of a reel. A DM-shared reel arrives as a
  // bare link — Instagram's share payload carries no caption — so until these
  // columns are filled the vault holds pointers, not knowledge. Each column is a
  // different place a reel keeps what it is actually teaching:
  //   caption        — the poster's own text, re-fetched by shortcode
  //   transcript     — spoken audio, transcribed locally (Whisper)
  //   ocr_text       — text burned onto the video, read off sampled keyframes
  //   entities       — JSON: named things worth their own list (films, portals,
  //                    tools, models, universities), extracted at enrich time
  //   actions        — JSON: concrete steps the reel actually asks you to take
  //   content_status — pipeline position, so extraction resumes where it stopped
  //   content_error  — why the last attempt failed, for retry triage
  for (const col of [
    "alter table items add column media_file text",
    "alter table items add column video text",
    "alter table items add column video_file text",
    "alter table items add column caption text",
    "alter table items add column transcript text",
    "alter table items add column ocr_text text",
    "alter table items add column entities text not null default '[]'",
    "alter table items add column actions text not null default '[]'",
    "alter table items add column content_status text not null default 'pending'",
    "alter table items add column content_error text",
    "alter table items add column keyframe_file text",
    "alter table items add column duration_s real",
    "alter table items add column music text",
    "alter table items add column fetcher text",
    "alter table items add column enrich_attempts integer not null default 0",
  ]) {
    try {
      d.exec(col);
    } catch {
      /* column already exists */
    }
  }
  d.exec("create index if not exists items_content_status_idx on items(content_status)");

  _db = d;
  return d;
}

// ----------------------------- items -----------------------------

export interface Item {
  id: string;
  url: string;
  source: "instagram" | "article" | "other";
  title: string;
  author: string | null;
  thumbnail: string | null;
  summary: string | null;
  category: string;
  tags: string[];
  notes: string | null;
  origin: "saved" | "manual" | "dm_shared";
  created_at: string;
  /** Cached thumbnail filename under data/media, or null when not held locally. */
  media_file: string | null;
  /** Remote video URL from the sidecar, kept as the re-fetch source. */
  video: string | null;
  /** Cached video filename under data/media. */
  video_file: string | null;
  /** Resolved image the UI should load: local file, else a live remote URL, else null. */
  poster: string | null;
  /** Resolved local video the UI can play, or null. */
  clip: string | null;
  /** The poster's own caption, re-fetched by shortcode. */
  caption: string | null;
  /** Spoken audio, transcribed locally. */
  transcript: string | null;
  /** Text burned onto the video, read off sampled keyframes. */
  ocr_text: string | null;
  /** Named things the reel is about — films, portals, tools, models, schools. */
  entities: Entity[];
  /** Concrete steps the reel asks you to take. */
  actions: string[];
  /** Where this item sits in the extraction pipeline. */
  content_status: ContentStatus;
  /** Why the last extraction attempt failed, if it did. */
  content_error: string | null;
  /** One JPEG under data/media — first content frame (t≈1.0 s). */
  keyframe_file: string | null;
  /** Clip length in seconds from Apify or ffprobe. */
  duration_s: number | null;
  /** JSON musicInfo: {"song","artist","original"}. */
  music: string | null;
  /** Which fetcher filled caption/video: apify | sidecar. */
  fetcher: string | null;
  /** How many enrich attempts have failed; ≥3 drops out of the queue. */
  enrich_attempts: number;
}

/**
 * A named thing worth pulling out of a reel and listing on its own. The whole
 * point of `kind` is that "the anime someone recommended" and "the job portal
 * someone linked" are different questions, and a flat tag list cannot answer
 * either one — you want the watchlist separate from the applications list.
 */
export interface Entity {
  kind: EntityKind;
  name: string;
  /** Optional link the reel gave for this thing. */
  url?: string;
  /** One-line note on why it came up. */
  note?: string;
}

/**
 * pending      — nothing fetched yet
 * fetched      — caption + video URL retrieved from the sidecar
 * transcribed  — audio transcribed and keyframes read
 * enriched     — summary, category, entities, and actions written
 * failed       — see content_error; safe to retry
 * unavailable  — the reel is deleted or private; retrying will not help
 */
export type ContentStatus =
  | "pending"
  | "fetched"
  | "transcribed"
  | "enriched"
  | "failed"
  | "unavailable";

// created_at may be supplied (e.g. the reel's original Instagram date) so the
// vault sorts by when things actually happened, not when they were imported.
// `poster` and `clip` are derived on read, never written. The cache fields are
// optional so ingest can store an item first and cache its media afterwards.
export type NewItem = Omit<
  Item,
  | "id" | "created_at" | "poster" | "clip" | "media_file" | "video" | "video_file"
  | "caption" | "transcript" | "ocr_text" | "entities" | "actions"
  | "content_status" | "content_error"
  | "keyframe_file" | "duration_s" | "music" | "fetcher" | "enrich_attempts"
> & {
  created_at?: string;
  media_file?: string | null;
  video?: string | null;
  video_file?: string | null;
  caption?: string | null;
  transcript?: string | null;
  ocr_text?: string | null;
  entities?: Entity[];
  actions?: string[];
  content_status?: ContentStatus;
  content_error?: string | null;
  keyframe_file?: string | null;
  duration_s?: number | null;
  music?: string | null;
  fetcher?: string | null;
  enrich_attempts?: number;
};

interface ItemRow {
  id: string; url: string; source: string; title: string; author: string | null;
  thumbnail: string | null; summary: string | null; category: string; tags: string;
  notes: string | null; origin: string; created_at: string;
  media_file: string | null; video: string | null; video_file: string | null;
  caption: string | null; transcript: string | null; ocr_text: string | null;
  entities: string; actions: string;
  content_status: string; content_error: string | null;
  keyframe_file: string | null; duration_s: number | null;
  music: string | null; fetcher: string | null;
  enrich_attempts: number;
}

function rowToItem(r: ItemRow): Item {
  return {
    id: r.id, url: r.url, source: r.source as Item["source"], title: r.title,
    author: r.author, thumbnail: r.thumbnail, summary: r.summary, category: r.category,
    tags: safeArray(r.tags), notes: r.notes, origin: r.origin as Item["origin"],
    created_at: r.created_at,
    media_file: r.media_file ?? null,
    video: r.video ?? null,
    video_file: r.video_file ?? null,
    // What the UI should actually load. A cached file is served from this
    // machine and never expires; the remote URL is the fallback and is only
    // worth trying when its signature has not already lapsed.
    poster: r.media_file
      ? `/api/media/${r.media_file}`
      : isExpired(r.thumbnail)
        ? null
        : r.thumbnail,
    // A cached clip plays straight from disk. One that is only a remote URL is
    // still playable — /api/media/clip fetches and keeps it on first watch —
    // but a dead signature is not worth offering a player for.
    clip: r.video_file
      ? `/api/media/${r.video_file}`
      : r.video && !isExpired(r.video)
        ? `/api/media/clip/${r.id}`
        : null,
    caption: r.caption ?? null,
    transcript: r.transcript ?? null,
    ocr_text: r.ocr_text ?? null,
    entities: safeEntities(r.entities ?? "[]"),
    actions: safeArray(r.actions ?? "[]"),
    content_status: (r.content_status ?? "pending") as ContentStatus,
    content_error: r.content_error ?? null,
    keyframe_file: r.keyframe_file ?? null,
    duration_s: r.duration_s ?? null,
    music: r.music ?? null,
    fetcher: r.fetcher ?? null,
    enrich_attempts: r.enrich_attempts ?? 0,
  };
}

/**
 * Entities come back from a language model, so the shape is a hope, not a
 * guarantee. Drop anything without a usable name rather than letting a
 * half-formed record reach the UI.
 */
function safeEntities(json: string): Entity[] {
  try {
    const v = JSON.parse(json);
    if (!Array.isArray(v)) return [];
    return v.flatMap((e): Entity[] => {
      if (!e || typeof e !== "object") return [];
      const name = typeof e.name === "string" ? e.name.trim() : "";
      if (!name) return [];
      return [{
        kind: typeof e.kind === "string" ? (e.kind as Entity["kind"]) : "other",
        name,
        ...(typeof e.url === "string" && e.url ? { url: e.url } : {}),
        ...(typeof e.note === "string" && e.note ? { note: e.note } : {}),
      }];
    });
  } catch {
    return [];
  }
}

function safeArray(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export interface VaultState {
  items: number;
  described: number;
  conversations: number;
  /** ISO timestamp of the most recent item added, or null on an empty vault. */
  lastAdded: string | null;
}

/**
 * The numbers the stack states about itself on every screen: how much is here,
 * how much of it is actually described, and how stale it has gone. Undescribed
 * and stale are the vault's real condition, so they are read straight from the
 * table rather than inferred in the UI.
 */
export async function getVaultState(): Promise<VaultState> {
  const d = db();
  const one = (sql: string): number =>
    Number((d.prepare(sql).get() as { n?: number } | undefined)?.n ?? 0);

  const lastAdded =
    (
      d
        .prepare("select max(added_at) as t from items")
        .get() as { t?: string | null } | undefined
    )?.t ?? null;

  return {
    items: one("select count(*) as n from items"),
    described: one(
      "select count(*) as n from items where summary is not null and summary <> ''",
    ),
    conversations: one("select count(*) as n from conversations"),
    lastAdded,
  };
}

export async function listItems(category?: string): Promise<Item[]> {
  const d = db();
  // Tie-break by rowid desc (true insertion order): a whole sync batch can share
  // one timestamp, so without this the newest-inserted rows fall to the bottom.
  const rows = category
    ? (d.prepare("select * from items where category = ? order by added_at desc, rowid desc").all(category) as unknown as ItemRow[])
    : (d.prepare("select * from items order by added_at desc, rowid desc").all() as unknown as ItemRow[]);
  return rows.map(rowToItem);
}

export interface CardPosition {
  /** 1-based position of this card in the stack's default order. */
  index: number;
  total: number;
  previousId: string | null;
  nextId: string | null;
}

/**
 * Where a card sits in the stack, so a card can be paged to the one before and
 * after it. Mirrors listItems()'s ordering exactly; if that ordering changes,
 * this must change with it or the paging will disagree with the grid.
 */
export async function getCardPosition(id: string): Promise<CardPosition | null> {
  const rows = db()
    .prepare("select id from items order by added_at desc, rowid desc")
    .all() as unknown as { id: string }[];

  const index = rows.findIndex((r) => r.id === id);
  if (index === -1) return null;

  return {
    index: index + 1,
    total: rows.length,
    previousId: index > 0 ? rows[index - 1].id : null,
    nextId: index < rows.length - 1 ? rows[index + 1].id : null,
  };
}

export async function getItem(id: string): Promise<Item | null> {
  const r = db().prepare("select * from items where id = ?").get(id) as unknown as ItemRow | undefined;
  return r ? rowToItem(r) : null;
}

export async function upsertItem(item: NewItem): Promise<Item> {
  const d = db();
  const existing = d.prepare("select id, created_at, added_at from items where url = ?").get(item.url) as
    | { id: string; created_at: string; added_at: string }
    | undefined;
  const id = existing?.id ?? randomUUID();
  const now = new Date().toISOString();
  // Prefer the caller-supplied original date; keep the existing one otherwise.
  const created_at = item.created_at ?? existing?.created_at ?? now;
  // added_at is set once, when the item first enters the vault. A re-sync keeps
  // the original add time (NOT in the conflict update set), so the home view
  // doesn't reshuffle every time you sync.
  const added_at = existing?.added_at || now;
  d.prepare(
    `insert into items (id, url, source, title, author, thumbnail, summary, category, tags, notes, origin, created_at, added_at, media_file, video, video_file, caption, transcript, ocr_text, entities, actions, content_status, content_error)
     values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     on conflict(url) do update set
       source=excluded.source, title=excluded.title, author=excluded.author,
       thumbnail=excluded.thumbnail, category=excluded.category, origin=excluded.origin,
       created_at=excluded.created_at, video=excluded.video,
       -- Everything written AFTER ingest survives a re-sync. Instagram never
       -- sends a summary, tags, or notes, so taking excluded.* here meant every
       -- sync silently erased the AI descriptions and the owner's own notes.
       summary=coalesce(excluded.summary, items.summary),
       notes=coalesce(excluded.notes, items.notes),
       tags=case when excluded.tags in ('[]','') then items.tags else excluded.tags end,
       -- A re-sync brings fresh remote URLs but must not drop bytes already on
       -- disk: keep the cached file unless this call supplies a new one.
       media_file=coalesce(excluded.media_file, items.media_file),
       video_file=coalesce(excluded.video_file, items.video_file),
       -- Extracted content is expensive: a caption costs a throttled API call, a
       -- transcript costs minutes of local compute. A re-sync must never trade
       -- that away for the empty fields Instagram sends on every share.
       caption=coalesce(excluded.caption, items.caption),
       transcript=coalesce(excluded.transcript, items.transcript),
       ocr_text=coalesce(excluded.ocr_text, items.ocr_text),
       entities=case when excluded.entities in ('[]','') then items.entities else excluded.entities end,
       actions=case when excluded.actions in ('[]','') then items.actions else excluded.actions end,
       content_status=case when excluded.content_status = 'pending' then items.content_status else excluded.content_status end,
       content_error=excluded.content_error`,
  ).run(
    id, item.url, item.source, item.title, item.author, item.thumbnail, item.summary,
    item.category, JSON.stringify(item.tags ?? []), item.notes, item.origin, created_at, added_at,
    item.media_file ?? null, item.video ?? null, item.video_file ?? null,
    item.caption ?? null, item.transcript ?? null, item.ocr_text ?? null,
    JSON.stringify(item.entities ?? []), JSON.stringify(item.actions ?? []),
    item.content_status ?? "pending", item.content_error ?? null,
  );

  const row = d.prepare("select * from items where id = ?").get(id) as unknown as ItemRow;
  return rowToItem(row);
}

export async function updateItem(id: string, patch: Partial<NewItem>): Promise<void> {
  const d = db();
  const sets: string[] = [];
  const vals: unknown[] = [];
  const jsonCols = new Set(["tags", "entities", "actions"]);
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    sets.push(`${k} = ?`);
    vals.push(jsonCols.has(k) ? JSON.stringify(v) : v);
  }
  if (!sets.length) return;
  vals.push(id);
  d.prepare(`update items set ${sets.join(", ")} where id = ?`).run(...(vals as never[]));
}

export async function removeItem(id: string): Promise<void> {
  db().prepare("delete from items where id = ?").run(id);
}

export async function searchItems(text: string): Promise<Item[]> {
  const term = text.trim().toLowerCase();
  if (!term) return [];
  const like = `%${term}%`;
  const rows = db()
    .prepare(
      `select * from items
       where lower(title) like ? or lower(coalesce(summary,'')) like ?
          or lower(coalesce(notes,'')) like ? or lower(category) like ?
          or lower(tags) like ?
          -- The reel's own words matter more than the metadata around it: a
          -- search for "scholarship" should hit a reel that says the word out
          -- loud even when nobody tagged it that way.
          or lower(coalesce(caption,'')) like ? or lower(coalesce(transcript,'')) like ?
          or lower(coalesce(ocr_text,'')) like ? or lower(entities) like ?
       order by added_at desc, rowid desc`,
    )
    .all(like, like, like, like, like, like, like, like, like) as unknown as ItemRow[];
  return rows.map(rowToItem);
}

/**
 * Higher-recall search for chat: runs searchItems on the whole query AND on each
 * word token, unions the results (deduped by id, first-seen order preserved), and
 * caps the candidate set. Tokens shorter than 2 chars are ignored.
 */
export async function searchItemsExpanded(text: string, cap = 40): Promise<Item[]> {
  const seen = new Map<string, Item>();
  const terms = [text, ...text.split(/\s+/)]
    .map((t) => t.trim())
    .filter((t, i, arr) => t.length >= 2 && arr.indexOf(t) === i);
  for (const term of terms) {
    const rows = await searchItems(term);
    for (const it of rows) {
      if (!seen.has(it.id)) seen.set(it.id, it);
      if (seen.size >= cap) break;
    }
    if (seen.size >= cap) break;
  }
  return [...seen.values()].slice(0, cap);
}

/** Fetch items by id, preserving the order of the supplied ids; unknown ids are dropped. */
export async function getItemsByIds(ids: string[]): Promise<Item[]> {
  const unique = ids.filter((id, i) => ids.indexOf(id) === i);
  if (!unique.length) return [];
  const placeholders = unique.map(() => "?").join(",");
  const rows = db()
    .prepare(`select * from items where id in (${placeholders})`)
    .all(...(unique as never[])) as unknown as ItemRow[];
  const byId = new Map(rows.map((r) => [r.id, rowToItem(r)]));
  return unique.map((id) => byId.get(id)).filter((x): x is Item => x !== undefined);
}

export async function listPendingItems(limit = 20): Promise<Item[]> {
  const rows = db()
    .prepare("select * from items where summary is null or summary = '' limit ?")
    .all(limit) as unknown as ItemRow[];
  return rows.map(rowToItem);
}

/**
 * Items the extraction pipeline still owes work on. `unavailable` is excluded
 * on purpose — a deleted reel is not a retry candidate, and leaving it in the
 * queue means the drip spends its rate limit re-failing the same dead links.
 */
export async function listItemsNeedingExtraction(limit = 25): Promise<Item[]> {
  const rows = db()
    .prepare(
      `select * from items
       where content_status in ('pending','fetched','failed')
       order by case content_status
                  when 'fetched' then 0   -- half-done: finish these first
                  when 'pending' then 1
                  else 2                  -- failed: retry last
                end,
                added_at desc
       limit ?`,
    )
    .all(limit) as unknown as ItemRow[];
  return rows.map(rowToItem);
}

// Every branch needs at least one text field — music-only `transcribed` rows
// must not sit at the front of the queue forever with attempts stuck at 0.
const ENRICH_ELIGIBLE = `
  (content_status = 'transcribed'
      or (content_status != 'unavailable'
          and (summary is null or summary = '')))
  and (coalesce(caption,'') != '' or coalesce(transcript,'') != '' or coalesce(ocr_text,'') != '')
  and coalesce(enrich_attempts, 0) < 3
`;

/** Items with extracted text but no summary yet — the enricher's queue. */
export async function listItemsNeedingEnrichment(limit = 20): Promise<Item[]> {
  const rows = db()
    .prepare(
      `select * from items
       where ${ENRICH_ELIGIBLE}
       order by coalesce(enrich_attempts, 0) asc, added_at desc
       limit ?`,
    )
    .all(limit) as unknown as ItemRow[];
  return rows.map(rowToItem);
}

/** How many items are still eligible for enrichment (attempts < 3). */
export async function countItemsNeedingEnrichment(): Promise<number> {
  const row = db()
    .prepare(`select count(*) as n from items where ${ENRICH_ELIGIBLE}`)
    .get() as { n: number };
  return row?.n ?? 0;
}

/** Every distinct entity in the vault, most-referenced first. Powers "list every anime I saved". */
export async function listEntities(kind?: string): Promise<
  { kind: string; name: string; count: number; itemIds: string[] }[]
> {
  const rows = db()
    .prepare("select id, entities from items where entities != '[]'")
    .all() as unknown as { id: string; entities: string }[];
  // Grouped in JS rather than SQL: entities live in a JSON column, and the
  // vault is small enough (hundreds, not millions) that a scan beats the
  // complexity of maintaining a shadow table.
  const acc = new Map<string, { kind: string; name: string; count: number; itemIds: string[] }>();
  for (const r of rows) {
    for (const e of safeEntities(r.entities)) {
      if (kind && e.kind !== kind) continue;
      const key = `${e.kind}::${e.name.toLowerCase()}`;
      const hit = acc.get(key);
      if (hit) {
        hit.count += 1;
        if (!hit.itemIds.includes(r.id)) hit.itemIds.push(r.id);
      } else {
        acc.set(key, { kind: e.kind, name: e.name, count: 1, itemIds: [r.id] });
      }
    }
  }
  return [...acc.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** Coverage counts, so it is always visible how much of the vault is actually readable. */
export async function extractionStats(): Promise<Record<string, number>> {
  const d = db();
  const row = d
    .prepare(
      `select count(*) as total,
              count(*) filter (where coalesce(caption,'') != '')    as with_caption,
              count(*) filter (where coalesce(transcript,'') != '') as with_transcript,
              count(*) filter (where coalesce(ocr_text,'') != '')   as with_ocr,
              count(*) filter (where coalesce(summary,'') != '')    as with_summary,
              count(*) filter (where content_status = 'unavailable') as unavailable,
              count(*) filter (where content_status = 'failed')      as failed
       from items`,
    )
    .get() as unknown as Record<string, number>;
  return row;
}

// ----------------------------- conversations + messages -----------------------------

export interface Conversation {
  id: string;
  thread_key: string;
  title: string;
  participants: string[];
  last_message_at: string | null;
  created_at: string;
}

export interface Message {
  id: string;
  conversation_id: string;
  external_id: string;
  sender: string;
  content: string | null;
  sent_at: string;
  shared_url: string | null;
}

interface ConvRow {
  id: string; thread_key: string; title: string; participants: string;
  last_message_at: string | null; created_at: string;
}

function rowToConv(r: ConvRow): Conversation {
  return {
    id: r.id, thread_key: r.thread_key, title: r.title,
    participants: safeArray(r.participants), last_message_at: r.last_message_at,
    created_at: r.created_at,
  };
}

export async function listConversations(): Promise<Conversation[]> {
  const rows = db()
    .prepare("select * from conversations order by last_message_at desc nulls last")
    .all() as unknown as ConvRow[];
  return rows.map(rowToConv);
}

export async function getConversation(
  id: string,
): Promise<{ conversation: Conversation | null; messages: Message[] }> {
  const c = db().prepare("select * from conversations where id = ?").get(id) as unknown as ConvRow | undefined;
  const messages = db()
    .prepare("select * from messages where conversation_id = ? order by sent_at asc")
    .all(id) as unknown as Message[];
  return { conversation: c ? rowToConv(c) : null, messages };
}

export async function searchMessages(text: string): Promise<Message[]> {
  const term = text.trim().toLowerCase();
  if (!term) return [];
  const like = `%${term}%`;
  return db()
    .prepare(
      `select * from messages
       where lower(coalesce(content,'')) like ? or lower(sender) like ?
       order by sent_at desc limit 100`,
    )
    .all(like, like) as unknown as Message[];
}

/** Upsert a conversation by thread_key, returning its id. */
export async function upsertConversation(c: {
  thread_key: string; title: string; participants: string[]; last_message_at: string | null;
}): Promise<string> {
  const d = db();
  const existing = d.prepare("select id from conversations where thread_key = ?").get(c.thread_key) as
    | { id: string }
    | undefined;
  const id = existing?.id ?? randomUUID();
  d.prepare(
    `insert into conversations (id, thread_key, title, participants, last_message_at, created_at)
     values (?,?,?,?,?,?)
     on conflict(thread_key) do update set
       title=excluded.title, participants=excluded.participants, last_message_at=excluded.last_message_at`,
  ).run(id, c.thread_key, c.title, JSON.stringify(c.participants ?? []), c.last_message_at, new Date().toISOString());
  return id;
}

/** Insert a message; ignores duplicates by (conversation_id, external_id). Returns true if inserted. */
export async function insertMessage(m: {
  conversation_id: string; external_id: string; sender: string;
  content: string | null; sent_at: string; shared_url: string | null;
}): Promise<boolean> {
  const res = db()
    .prepare(
      `insert or ignore into messages (id, conversation_id, external_id, sender, content, sent_at, shared_url)
       values (?,?,?,?,?,?,?)`,
    )
    .run(randomUUID(), m.conversation_id, m.external_id, m.sender, m.content, m.sent_at, m.shared_url);
  return Number(res.changes) > 0;
}

// ----------------------------- sync history -----------------------------
// The sidecar keeps its throttle state in memory and forgets it on restart, so
// "when did this vault last sync, and what came in" is recorded here instead.

export interface SyncRun {
  id: string;
  started_at: string;
  finished_at: string;
  status: "done" | "error";
  items: number;
  conversations: number;
  messages: number;
  skipped: number;
  error: string | null;
}

export async function recordSyncRun(r: Omit<SyncRun, "id">): Promise<void> {
  db()
    .prepare(
      `insert into sync_runs (id, started_at, finished_at, status, items, conversations, messages, skipped, error)
       values (?,?,?,?,?,?,?,?,?)`,
    )
    .run(randomUUID(), r.started_at, r.finished_at, r.status, r.items, r.conversations, r.messages, r.skipped, r.error);
}

export async function listSyncRuns(limit = 10): Promise<SyncRun[]> {
  return db()
    .prepare("select * from sync_runs order by started_at desc limit ?")
    .all(limit) as unknown as SyncRun[];
}
