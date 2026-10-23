#!/usr/bin/env node
/**
 * Reel Vault — MCP server.
 *
 * Exposes the vault over stdio so an AI assistant can search and read the reels
 * you saved, in any conversation, without opening the app. This is the piece
 * that turns "I saved something about this once" into an answer.
 *
 * Zero dependencies on purpose. node:sqlite is built into Node and the MCP
 * stdio transport is newline-delimited JSON-RPC 2.0, so there is nothing to
 * npm install, nothing to keep up to date, and nothing that can break the
 * server months from now when a package publishes a major version.
 *
 * Read-only by design. A tool that can edit the vault is a tool that can
 * silently corrupt years of saved material because a model misread a request.
 * Writing stays in the app, where you can see what changed.
 *
 * Register it with Claude Code / Cowork:
 *   claude mcp add reel-vault -- node /absolute/path/to/mcp/reel-vault-mcp.mjs
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.REEL_VAULT_DB ?? path.join(HERE, "..", "data", "reel-vault.db");

// Node emits an ExperimentalWarning the first time node:sqlite loads. On stdio
// transports anything on stdout corrupts the protocol stream; warnings go to
// stderr so they are safe, but silencing it keeps the client's logs readable.
const _emit = process.emitWarning.bind(process);
process.emitWarning = (w, ...rest) => {
  const text = typeof w === "string" ? w : w?.message ?? "";
  if (text.includes("SQLite is an experimental feature")) return;
  return _emit(w, ...rest);
};

const sqlite = process.getBuiltinModule?.("node:sqlite");
if (!sqlite?.DatabaseSync) {
  console.error("reel-vault-mcp: needs Node 22.5+ (Node 24 recommended) for node:sqlite.");
  process.exit(1);
}
if (!existsSync(DB_PATH)) {
  console.error(`reel-vault-mcp: no vault at ${DB_PATH}`);
  process.exit(1);
}

let db = new sqlite.DatabaseSync(DB_PATH, { readOnly: true });

/**
 * This process lives as long as the Claude session, often for days. If the
 * vault file is replaced underneath it (a restore from backup, a copy from the
 * Windows box), the open connection keeps stale pages and every query fails
 * with "database disk image is malformed" even though the file is fine.
 * Reopening picks up the new file.
 */
function reopen() {
  try {
    db.close();
  } catch {}
  db = new sqlite.DatabaseSync(DB_PATH, { readOnly: true });
  COLUMNS = readColumns();
  HAS_CONTENT = COLUMNS.has("caption") && COLUMNS.has("entities");
}

const isStale = (err) => /malformed|not a database|SQLITE_CORRUPT|SQLITE_NOTADB|no such table/i.test(String(err?.message ?? err));

/**
 * The content columns are added by a migration that runs when the Next app or
 * the extraction pipeline starts. This server opens the file read-only, so it
 * cannot add them itself and must not assume they exist — a fresh clone, or a
 * vault whose app has not been started since the upgrade, would otherwise make
 * every tool fail with a raw "no such column".
 *
 * Missing columns are substituted with SQL literals, so queries stay valid and
 * the tools degrade to "links only" instead of breaking.
 */
const readColumns = () => new Set(db.prepare("pragma table_info(items)").all().map((r) => r.name));
let COLUMNS = readColumns();
let HAS_CONTENT = COLUMNS.has("caption") && COLUMNS.has("entities");

/** `col("caption")` -> `caption`, or `null` when that column does not exist yet. */
const col = (name, missing = "null") => (COLUMNS.has(name) ? name : missing);
/** Text column safe for `like`: empty string when absent. */
const txt = (name) => (COLUMNS.has(name) ? `coalesce(${name},'')` : `''`);
/** JSON array column: an empty array literal when absent. */
const arr = (name) => (COLUMNS.has(name) ? name : `'[]'`);

const SETUP_HINT =
  "This vault has not been upgraded for content extraction yet — it holds links but " +
  "no captions, transcripts, or summaries. Start the app once (npm run dev) to apply " +
  "the migration, then run pipeline/extract.py. See docs/KNOWLEDGE-BASE.md.";

// ----------------------------- shaping -----------------------------

const json = (s, fallback = []) => {
  try {
    const v = JSON.parse(s ?? "[]");
    return Array.isArray(v) ? v : fallback;
  } catch {
    return fallback;
  }
};

/**
 * Trim an item to what is worth spending context on.
 *
 * Transcripts run to thousands of characters. Returning twenty of them in full
 * would bury the answer in raw material, so search results carry a snippet and
 * the full text is one get_item call away.
 */
function shape(row, { full = false } = {}) {
  const out = {
    id: row.id,
    title: row.title,
    url: row.url,
    author: row.author,
    category: row.category,
    tags: json(row.tags),
    summary: row.summary,
    entities: json(row.entities),
    actions: json(row.actions),
    saved_at: row.created_at,
  };
  if (full) {
    out.caption = row.caption;
    out.transcript = row.transcript;
    out.on_screen_text = row.ocr_text;
    out.notes = row.notes;
    out.content_status = row.content_status;
  } else {
    const body = row.transcript || row.caption || row.ocr_text || "";
    if (body) out.excerpt = body.slice(0, 300) + (body.length > 300 ? "…" : "");
    // Say so explicitly. A model that cannot tell "no transcript" from "empty
    // transcript" will confidently report that a reel says nothing.
    out.has_transcript = !!row.transcript;
  }
  return out;
}

const ITEM_COLS = [
  "id", "url", "title", "author", "category", "tags", "summary", "created_at", "notes",
  `${arr("entities")} as entities`,
  `${arr("actions")} as actions`,
  `${col("caption")} as caption`,
  `${col("transcript")} as transcript`,
  `${col("ocr_text")} as ocr_text`,
  `${col("content_status", "'pending'")} as content_status`,
].join(",");

// ----------------------------- tools -----------------------------

const STOPWORDS = new Set((
  "a an the and or of to for in on at by with from into about is are was were be " +
  "it its this that these those which who what when where how can could will would " +
  "should do does did me my i you your we our us any some all get got there here " +
  "reel reels post posts saved save"
).split(" "));

/**
 * Split a query into the words worth matching on their own.
 *
 * Matching the query as one substring meant "claude video" found nothing even
 * when an item said "Claude" and "videos" — the words are rarely adjacent.
 * Plurals are trimmed to their stem so "images" also hits "image".
 */
function queryTerms(query) {
  const words = String(query ?? "").toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}.+#-]*/gu) ?? [];
  const terms = new Set();
  for (let w of words) {
    w = w.replace(/[.-]+$/, "");
    if (!w || STOPWORDS.has(w)) continue;
    if (w.length > 4 && /(ch|sh|x|ss)es$/.test(w)) w = w.slice(0, -2);
    else if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
    terms.add(w);
  }
  return [...terms];
}

function searchVault({ query, limit = 12, category }) {
  const q = String(query ?? "").trim();
  if (!q) return { results: [], note: "empty query" };
  let terms = queryTerms(q);
  // A query made only of stopwords ("how to") still deserves a literal try.
  if (terms.length === 0) terms = [q.toLowerCase()];
  terms = terms.slice(0, 12);

  // Each term is ranked by where it appears, not just whether it does: a reel
  // whose title or summary is about the topic beats one that mentions it in
  // passing halfway through a transcript. Items matching more of the terms
  // rank first, so a partial match never outranks a complete one.
  const termScore = (p) => `(
      (case when lower(coalesce(title,''))  like ${p} then 100 else 0 end) +
      (case when lower(coalesce(summary,''))like ${p} then 60  else 0 end) +
      (case when lower(${arr("entities")})  like ${p} then 50  else 0 end) +
      (case when lower(coalesce(tags,''))   like ${p} then 40  else 0 end) +
      (case when lower(coalesce(category,''))like ${p} then 30 else 0 end) +
      (case when lower(${txt("caption")})   like ${p} then 20  else 0 end) +
      (case when lower(${txt("ocr_text")})  like ${p} then 15  else 0 end) +
      (case when lower(${txt("transcript")})like ${p} then 10  else 0 end) +
      (case when lower(coalesce(notes,''))  like ${p} then 10  else 0 end))`;
  const args = terms.map((t) => `%${t.replace(/[\\%_]/g, (c) => "\\" + c)}%`);
  const cols = args.map((_, i) => `${termScore(`?${i + 1} escape '\\'`)} as t${i}`);
  const hits = args.map((_, i) => `(t${i} > 0)`).join(" + ");
  const score = args.map((_, i) => `t${i}`).join(" + ");
  const limitP = `?${args.length + 1}`;
  const categoryP = `?${args.length + 2}`;

  const sql = `
    select * from (
      select ${ITEM_COLS}, ${cols.join(", ")}
      from items
      ${category ? `where lower(category) = lower(${categoryP})` : ""}
    )
    where (${hits}) > 0
    order by (${hits}) desc, (${score}) desc, created_at desc
    limit ${limitP}`;
  const rows = db.prepare(sql).all(
    ...args, Math.min(Number(limit) || 12, 50), ...(category ? [category] : []),
  );
  return {
    query: q,
    terms,
    count: rows.length,
    results: rows.map((r) => {
      const matched = terms.filter((_, i) => r[`t${i}`] > 0);
      return {
        ...shape(r),
        ...(matched.length < terms.length && { matched_terms: matched }),
      };
    }),
    ...(rows.length === 0 && { note: unenrichedHint() }),
  };
}

/**
 * An empty result is ambiguous: nothing saved on the topic, or nothing
 * extracted yet? Saying which prevents the assistant from reporting a gap in
 * the user's knowledge that is really a gap in the pipeline.
 */
function unenrichedHint() {
  if (!HAS_CONTENT) return `No match. ${SETUP_HINT}`;
  const s = db.prepare(
    `select count(*) total, sum(coalesce(summary,'') = '') bare from items`,
  ).get();
  if (s.bare > 0) {
    return `No match. Note ${s.bare} of ${s.total} items have no extracted content yet ` +
           `(run pipeline/extract.py), so they are not searchable by what they contain.`;
  }
  return "No match in the vault.";
}

function getItem({ id }) {
  const row = db.prepare(`select ${ITEM_COLS} from items where id = ?`).get(String(id ?? ""));
  if (!row) return { error: `no item with id ${id}` };
  return shape(row, { full: true });
}

function listCategories() {
  const rows = db.prepare(
    `select category, count(*) count,
            sum(coalesce(summary,'') != '') enriched
     from items group by category order by count desc`,
  ).all();
  return { categories: rows };
}

function listEntities({ kind, limit = 100 }) {
  if (!HAS_CONTENT) return { count: 0, entities: [], note: SETUP_HINT };
  const rows = db.prepare("select id, title, entities from items where entities != '[]'").all();
  const acc = new Map();
  for (const r of rows) {
    for (const e of json(r.entities)) {
      if (!e?.name) continue;
      if (kind && e.kind !== kind) continue;
      const key = `${e.kind}::${String(e.name).toLowerCase()}`;
      const hit = acc.get(key);
      if (hit) {
        hit.mentions += 1;
        if (hit.items.length < 5) hit.items.push({ id: r.id, title: r.title });
      } else {
        acc.set(key, {
          kind: e.kind, name: e.name,
          ...(e.url && { url: e.url }),
          ...(e.note && { note: e.note }),
          mentions: 1,
          items: [{ id: r.id, title: r.title }],
        });
      }
    }
  }
  const all = [...acc.values()].sort(
    (a, b) => b.mentions - a.mentions || a.name.localeCompare(b.name),
  );
  return {
    ...(kind && { kind }),
    count: all.length,
    entities: all.slice(0, Math.min(Number(limit) || 100, 500)),
    ...(all.length === 0 && {
      note: "No entities extracted yet — run pipeline/extract.py then POST /api/enrich-pending.",
    }),
  };
}

function findActions({ topic, limit = 40 }) {
  if (!HAS_CONTENT) return { count: 0, actions: [], note: SETUP_HINT };
  const rows = db.prepare(
    `select id, title, category, actions, url from items where actions != '[]'`,
  ).all();
  const needle = String(topic ?? "").trim().toLowerCase();
  const out = [];
  for (const r of rows) {
    for (const a of json(r.actions)) {
      if (needle && !`${a} ${r.title} ${r.category}`.toLowerCase().includes(needle)) continue;
      out.push({ action: a, from: r.title, category: r.category, item_id: r.id, url: r.url });
    }
  }
  return { count: out.length, actions: out.slice(0, Math.min(Number(limit) || 40, 200)) };
}

function recentItems({ limit = 15 }) {
  const rows = db.prepare(
    `select ${ITEM_COLS} from items order by added_at desc, rowid desc limit ?`,
  ).all(Math.min(Number(limit) || 15, 50));
  return { count: rows.length, items: rows.map((r) => shape(r)) };
}

function vaultStats() {
  const s = db.prepare(
    `select count(*) total,
            sum(${txt("caption")}    != '') with_caption,
            sum(${txt("transcript")} != '') with_transcript,
            sum(${txt("ocr_text")}   != '') with_on_screen_text,
            sum(coalesce(summary,'') != '') with_summary,
            sum(${col("content_status", "''")} = 'unavailable') unavailable,
            sum(${col("content_status", "''")} = 'failed') failed
     from items`,
  ).get();
  const cats = db.prepare(
    "select category, count(*) n from items group by category order by n desc limit 12",
  ).all();
  const ents = HAS_CONTENT
    ? db.prepare("select count(*) n from items where entities != '[]'").get().n
    : 0;
  return {
    ...s,
    items_with_entities: ents,
    top_categories: cats,
    readable_percent: s.total ? Math.round((100 * s.with_summary) / s.total) : 0,
    note: !HAS_CONTENT
      ? SETUP_HINT
      : s.with_summary === 0
        ? "Nothing is enriched yet. The vault holds links but not their content — run pipeline/extract.py, then POST /api/enrich-pending."
        : undefined,
  };
}

const TOOLS = [
  {
    name: "search_vault",
    description:
      "Search the saved Instagram reels, posts, and articles by what they actually contain — " +
      "title, AI summary, caption, spoken transcript, on-screen text, tags, and extracted entities. " +
      "Use this first for any question about what the user has saved.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words to look for, e.g. 'scholarship deadline' or 'anime'." },
        limit: { type: "number", description: "Max results (default 12, cap 50)." },
        category: { type: "string", description: "Optional exact category filter." },
      },
      required: ["query"],
    },
    handler: searchVault,
  },
  {
    name: "get_item",
    description:
      "Fetch one saved item in full, including its complete transcript, caption, and on-screen text. " +
      "Use after search_vault when the excerpt is not enough to answer.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Item id from search_vault." } },
      required: ["id"],
    },
    handler: getItem,
  },
  {
    name: "list_entities",
    description:
      "List every specific named thing extracted across the vault — films, anime, books, tools, " +
      "AI models, job portals, universities, scholarships, companies. Use for 'what movies have I " +
      "saved' or 'which job portals did I come across'. Filter with kind.",
    inputSchema: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          description: "One of: movie, anime, show, book, tool, ai_model, job_portal, company, university, scholarship, person, place, course, other.",
        },
        limit: { type: "number" },
      },
    },
    handler: listEntities,
  },
  {
    name: "find_actions",
    description:
      "List the concrete steps the saved reels ask you to take — apply here, try this tool, meet " +
      "this deadline. Use to turn the vault into a to-do list. Optionally filter by topic.",
    inputSchema: {
      type: "object",
      properties: {
        topic: { type: "string", description: "Optional filter, e.g. 'jobs' or 'scholarship'." },
        limit: { type: "number" },
      },
    },
    handler: findActions,
  },
  {
    name: "list_categories",
    description: "List every category with how many items it holds and how many are enriched. Good for orienting before a search.",
    inputSchema: { type: "object", properties: {} },
    handler: listCategories,
  },
  {
    name: "recent_items",
    description: "The most recently added items, newest first. Use for 'what did I save lately'.",
    inputSchema: { type: "object", properties: { limit: { type: "number" } } },
    handler: recentItems,
  },
  {
    name: "vault_stats",
    description:
      "Coverage of the vault: how many items exist and how many have a caption, transcript, " +
      "on-screen text, and summary. Use to check whether a disappointing search means 'nothing " +
      "saved' or 'not extracted yet'.",
    inputSchema: { type: "object", properties: {} },
    handler: vaultStats,
  },
];

// ----------------------------- JSON-RPC over stdio -----------------------------

function send(msg) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
}

function handle(req) {
  const { id, method, params } = req;
  // Notifications have no id and must never be answered — replying to one is a
  // protocol violation that some clients treat as fatal.
  const isNotification = id === undefined || id === null;

  try {
    switch (method) {
      case "initialize":
        return send({
          id,
          result: {
            // Echo the client's version when it offers one: this server's
            // surface is plain tools, compatible across current revisions.
            protocolVersion: params?.protocolVersion ?? "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "reel-vault", version: "1.0.0" },
          },
        });

      case "tools/list":
        return send({
          id,
          result: {
            tools: TOOLS.map(({ name, description, inputSchema }) => ({
              name, description, inputSchema,
            })),
          },
        });

      case "tools/call": {
        const tool = TOOLS.find((t) => t.name === params?.name);
        if (!tool) {
          return send({ id, error: { code: -32602, message: `unknown tool: ${params?.name}` } });
        }
        let result;
        try {
          result = tool.handler(params?.arguments ?? {});
        } catch (err) {
          if (!isStale(err)) throw err;
          reopen();
          result = tool.handler(params?.arguments ?? {});
        }
        return send({
          id,
          result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] },
        });
      }

      case "ping":
        return send({ id, result: {} });

      default:
        if (isNotification) return; // notifications/initialized and friends
        return send({ id, error: { code: -32601, message: `unknown method: ${method}` } });
    }
  } catch (err) {
    if (isNotification) return;
    // A failing tool should report the failure, not kill the server and take
    // every other tool down with it.
    send({ id, error: { code: -32603, message: String(err?.message ?? err) } });
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let req;
    try {
      req = JSON.parse(line);
    } catch {
      continue; // a garbled line is not worth dying over
    }
    handle(req);
  }
});
process.stdin.on("end", () => process.exit(0));
