# Reel Vault v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate Reel Vault from Convex to Supabase Postgres and add ingestion of the Instagram data-export ZIP (saved reels/posts + direct messages), with AI enrichment, unified search, and a polished UI.

**Architecture:** Next.js 16 App Router frontend. Supabase Postgres backend accessed server-side via the Supabase JS client inside Next route handlers and server actions (service-role key server-only). All Reel Vault tables live in an isolated `reel_vault` Postgres schema in the existing project `upyxwlvlxobuqlxvzwal`. A `Connector` interface abstracts ingestion; `ExportConnector` (ZIP) is implemented now, `MessagingApiConnector` is a stub.

**Tech Stack:** Next.js 16, React 19, TypeScript, `@supabase/supabase-js`, `fflate` (unzip), Tailwind v4, Vitest, `@anthropic-ai/sdk`.

**Project facts (already verified):**
- Supabase project ref: `upyxwlvlxobuqlxvzwal`, URL `https://upyxwlvlxobuqlxvzwal.supabase.co`, region Mumbai.
- Get keys: `supabase projects api-keys --project-ref upyxwlvlxobuqlxvzwal` (anon + service_role).
- No Docker — use the hosted project, not local Supabase.
- Existing pure libs to KEEP: `src/lib/metadata.ts`, `src/lib/ai.ts`, `src/lib/instagram-export.ts`, `src/lib/passcode.ts` (+ their tests). Existing API routes to KEEP: `metadata`, `enrich`, `login`. Middleware passcode gate stays.

---

## File Structure

```
reel-vault/
  supabase/
    migrations/
      0001_reel_vault_schema.sql   schema reel_vault: items, conversations, messages, FTS, indexes
  src/
    lib/
      supabase.ts          server-only Supabase client (service role)
      db.ts                typed data-access fns (items + conversations + messages)
      instagram-export.ts  EXTEND: add parseInbox + parseSharedFromMessages
      connectors/
        types.ts           Connector + IngestResult interfaces
        export-connector.ts  ZIP -> parsed -> db upserts
        messaging-api.ts   stub MessagingApiConnector
    app/
      actions.ts           server actions: addItem, updateItem, removeItem, list, search, getItem, listConversations, getConversation
      api/
        ingest/route.ts    POST whole export zip -> ExportConnector
      page.tsx             dashboard (server component reads db.list)
      messages/page.tsx    conversation list
      messages/[id]/page.tsx  thread view
      item/[id]/page.tsx   item detail (server action backed)
      ingest/page.tsx      drag-drop ZIP upload + progress
    components/             polished UI (impeccable): ItemCard, ItemGrid, ConversationList, MessageThread, SearchBar, Shell
  docs/superpowers/specs/2026-06-02-reel-vault-v2-design.md
```

**Removed:** `convex/`, `src/components/ConvexClientProvider.tsx`, Convex imports in `layout.tsx`, Convex env vars. Convex-coupled pages (`src/app/page.tsx`, `src/app/add/page.tsx`, `src/app/item/[id]/page.tsx`, `src/app/import/page.tsx`, `src/components/ItemCard.tsx`, `ItemGrid.tsx`, `ReviewForm.tsx`) are rewritten against the new data layer.

---

## PHASE 0 — Supabase backend setup

### Task 1: Install deps and Supabase env

**Files:** Modify `package.json`, `.env.local`

- [ ] **Step 1: Install packages**

```bash
npm install @supabase/supabase-js fflate
npm uninstall convex
```

- [ ] **Step 2: Write Supabase env into `.env.local`** (keep existing APP_PASSCODE, ANTHROPIC_API_KEY; remove CONVEX_* and NEXT_PUBLIC_CONVEX_*)

Fetch keys: `supabase projects api-keys --project-ref upyxwlvlxobuqlxvzwal`. Append:

```
NEXT_PUBLIC_SUPABASE_URL=https://upyxwlvlxobuqlxvzwal.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service_role value from CLI>
SUPABASE_DB_SCHEMA=reel_vault
```

(Anon key not needed — all access is server-side via service role behind the passcode gate.)

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "chore: swap Convex for Supabase deps + env"
```

### Task 2: Create the Postgres schema

**Files:** Create `supabase/migrations/0001_reel_vault_schema.sql`

- [ ] **Step 1: Write the migration**

```sql
create schema if not exists reel_vault;

create table if not exists reel_vault.items (
  id uuid primary key default gen_random_uuid(),
  url text unique not null,
  source text not null check (source in ('instagram','article','other')),
  title text not null,
  author text,
  thumbnail text,
  summary text,
  category text not null default 'Uncategorized',
  tags text[] not null default '{}',
  notes text,
  origin text not null default 'saved' check (origin in ('saved','manual','dm_shared')),
  created_at timestamptz not null default now(),
  search tsvector generated always as (
    to_tsvector('english',
      coalesce(title,'') || ' ' || coalesce(summary,'') || ' ' ||
      coalesce(notes,'') || ' ' || coalesce(category,'') || ' ' ||
      array_to_string(tags, ' '))
  ) stored
);

create table if not exists reel_vault.conversations (
  id uuid primary key default gen_random_uuid(),
  thread_key text unique not null,
  title text not null,
  participants text[] not null default '{}',
  last_message_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists reel_vault.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references reel_vault.conversations(id) on delete cascade,
  external_id text not null,
  sender text not null,
  content text,
  sent_at timestamptz not null,
  shared_url text,
  search tsvector generated always as (
    to_tsvector('english', coalesce(content,'') || ' ' || coalesce(sender,''))
  ) stored,
  unique (conversation_id, external_id)
);

create index if not exists items_search_idx on reel_vault.items using gin(search);
create index if not exists items_tags_idx on reel_vault.items using gin(tags);
create index if not exists items_category_idx on reel_vault.items(category);
create index if not exists messages_search_idx on reel_vault.messages using gin(search);
create index if not exists messages_sent_idx on reel_vault.messages(sent_at desc);
create index if not exists conv_last_idx on reel_vault.conversations(last_message_at desc);
```

- [ ] **Step 2: Apply it to the hosted project**

Expose the schema to PostgREST so the JS client can reach it, then push:

```bash
# add reel_vault to exposed schemas (one time, via SQL since CLI not linked):
supabase db push --db-url "$(supabase projects api-keys --project-ref upyxwlvlxobuqlxvzwal >/dev/null; echo)"  # see note
```

Note: if `db push` requires a linked project/password and that is unavailable non-interactively, apply the SQL directly with `psql` using the project's connection string from the Supabase dashboard (Settings → Database → Connection string), OR run the SQL via the Supabase MCP `apply_migration` tool. Either path must (a) create the schema/tables above and (b) add `reel_vault` to the project's "Exposed schemas" (Dashboard → Project Settings → API → Exposed schemas) so `supabase-js` with `{ db: { schema: 'reel_vault' } }` works. Verify with: `curl -s -H "apikey: <anon>" "https://upyxwlvlxobuqlxvzwal.supabase.co/rest/v1/items?select=id&limit=1" -H "Accept-Profile: reel_vault"` → expect `[]` (200), not 404.

- [ ] **Step 3: Commit**

```bash
git add supabase/ && git commit -m "feat: add reel_vault Postgres schema"
```

### Task 3: Supabase server client

**Files:** Create `src/lib/supabase.ts`

- [ ] **Step 1: Implement**

```typescript
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const schema = process.env.SUPABASE_DB_SCHEMA ?? "reel_vault";

// Server-only. Never import this into a client component.
export const supabase = createClient(url, serviceKey, {
  db: { schema },
  auth: { persistSession: false, autoRefreshToken: false },
});
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/supabase.ts && git commit -m "feat: add server Supabase client"
```

---

## PHASE 1 — Data-access layer + remove Convex

### Task 4: Typed data-access functions

**Files:** Create `src/lib/db.ts`

- [ ] **Step 1: Define types + functions**

```typescript
import { supabase } from "./supabase";

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
}

export type NewItem = Omit<Item, "id" | "created_at">;

export async function listItems(category?: string): Promise<Item[]> {
  let q = supabase.from("items").select("*").order("created_at", { ascending: false });
  if (category) q = q.eq("category", category);
  const { data, error } = await q;
  if (error) throw error;
  return data ?? [];
}

export async function getItem(id: string): Promise<Item | null> {
  const { data, error } = await supabase.from("items").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return data;
}

export async function upsertItem(item: NewItem): Promise<Item> {
  const { data, error } = await supabase
    .from("items").upsert(item, { onConflict: "url" }).select().single();
  if (error) throw error;
  return data;
}

export async function updateItem(id: string, patch: Partial<NewItem>): Promise<void> {
  const { error } = await supabase.from("items").update(patch).eq("id", id);
  if (error) throw error;
}

export async function removeItem(id: string): Promise<void> {
  const { error } = await supabase.from("items").delete().eq("id", id);
  if (error) throw error;
}

export async function searchItems(text: string): Promise<Item[]> {
  const term = text.trim();
  if (!term) return [];
  const { data, error } = await supabase
    .from("items").select("*").textSearch("search", term, { type: "websearch" });
  if (error) throw error;
  return data ?? [];
}

export interface Conversation {
  id: string; thread_key: string; title: string;
  participants: string[]; last_message_at: string | null; created_at: string;
}
export interface Message {
  id: string; conversation_id: string; external_id: string;
  sender: string; content: string | null; sent_at: string; shared_url: string | null;
}

export async function listConversations(): Promise<Conversation[]> {
  const { data, error } = await supabase
    .from("conversations").select("*").order("last_message_at", { ascending: false, nullsFirst: false });
  if (error) throw error;
  return data ?? [];
}

export async function getConversation(id: string): Promise<{ conversation: Conversation | null; messages: Message[] }> {
  const { data: conversation } = await supabase.from("conversations").select("*").eq("id", id).maybeSingle();
  const { data: messages, error } = await supabase
    .from("messages").select("*").eq("conversation_id", id).order("sent_at", { ascending: true });
  if (error) throw error;
  return { conversation: conversation ?? null, messages: messages ?? [] };
}

export async function searchMessages(text: string): Promise<Message[]> {
  const term = text.trim();
  if (!term) return [];
  const { data, error } = await supabase
    .from("messages").select("*").textSearch("search", term, { type: "websearch" }).limit(100);
  if (error) throw error;
  return data ?? [];
}
```

- [ ] **Step 2: Commit** — `git add src/lib/db.ts && git commit -m "feat: add Supabase data-access layer"`

### Task 5: Remove Convex artifacts

**Files:** Delete `convex/`, `src/components/ConvexClientProvider.tsx`; Modify `src/app/layout.tsx`

- [ ] **Step 1: Delete**

```bash
git rm -r convex src/components/ConvexClientProvider.tsx
rm -rf .convex
```

- [ ] **Step 2: Un-wire provider in `src/app/layout.tsx`** — remove the `ConvexClientProvider` import and unwrap `{children}` so the body renders `{children}` directly (keep the manifest metadata + fonts).

- [ ] **Step 3: Verify** `npm run build` will fail here (pages still import convex) — expected until Phase 2/3 rewrites them. Commit the removal:

```bash
git add -A && git commit -m "chore: remove Convex client + generated code"
```

---

## PHASE 2 — Extend the Instagram export parser (TDD)

### Task 6: `parseInbox` — DM thread parser

**Files:** Modify `src/lib/instagram-export.ts`, `src/lib/instagram-export.test.ts`

Instagram export DM shape (`your_instagram_activity/messages/inbox/<thread>/message_1.json`):
```json
{ "participants": [{"name":"me"},{"name":"creatorA"}],
  "title": "creatorA",
  "thread_path": "inbox/creatora_123",
  "messages": [
    {"sender_name":"creatorA","timestamp_ms":1700000000000,"content":"hey check this",
     "share":{"link":"https://www.instagram.com/reel/AAA/"}},
    {"sender_name":"me","timestamp_ms":1700000100000,"content":"nice"} ] }
```

- [ ] **Step 1: Add failing tests** to `src/lib/instagram-export.test.ts`

```typescript
import { parseInbox } from "./instagram-export";

describe("parseInbox", () => {
  const raw = JSON.stringify({
    participants: [{ name: "me" }, { name: "creatorA" }],
    title: "creatorA",
    thread_path: "inbox/creatora_123",
    messages: [
      { sender_name: "creatorA", timestamp_ms: 1700000000000, content: "hey check this",
        share: { link: "https://www.instagram.com/reel/AAA/" } },
      { sender_name: "me", timestamp_ms: 1700000100000, content: "nice" },
    ],
  });

  it("parses a thread into conversation + messages", () => {
    const t = parseInbox(raw);
    expect(t).not.toBeNull();
    expect(t!.threadKey).toBe("inbox/creatora_123");
    expect(t!.title).toBe("creatorA");
    expect(t!.participants).toEqual(["me", "creatorA"]);
    expect(t!.messages).toHaveLength(2);
    expect(t!.messages[0]).toEqual({
      externalId: "creatorA:1700000000000",
      sender: "creatorA",
      content: "hey check this",
      sentAt: 1700000000000,
      sharedUrl: "https://www.instagram.com/reel/AAA/",
    });
    expect(t!.messages[1].sharedUrl).toBeUndefined();
  });

  it("returns null on malformed input", () => {
    expect(parseInbox("garbage")).toBeNull();
  });
});
```

- [ ] **Step 2: Run, verify fail** — `npm test -- src/lib/instagram-export.test.ts` → FAIL (no `parseInbox`).

- [ ] **Step 3: Implement in `src/lib/instagram-export.ts`** (append)

```typescript
export interface ParsedMessage {
  externalId: string;
  sender: string;
  content?: string;
  sentAt: number;
  sharedUrl?: string;
}
export interface ParsedThread {
  threadKey: string;
  title: string;
  participants: string[];
  messages: ParsedMessage[];
}

export function parseInbox(rawJson: string): ParsedThread | null {
  try {
    const d = JSON.parse(rawJson);
    if (!Array.isArray(d.messages)) return null;
    const participants = Array.isArray(d.participants)
      ? d.participants.map((p: { name?: string }) => p?.name).filter(Boolean)
      : [];
    const messages: ParsedMessage[] = d.messages.map((m: {
      sender_name?: string; timestamp_ms?: number; content?: string; share?: { link?: string };
    }) => ({
      externalId: `${m.sender_name ?? "?"}:${m.timestamp_ms ?? 0}`,
      sender: m.sender_name ?? "unknown",
      content: typeof m.content === "string" ? m.content : undefined,
      sentAt: typeof m.timestamp_ms === "number" ? m.timestamp_ms : 0,
      sharedUrl: m.share?.link && m.share.link.startsWith("http") ? m.share.link : undefined,
    }));
    return {
      threadKey: typeof d.thread_path === "string" ? d.thread_path : (d.title ?? "thread"),
      title: typeof d.title === "string" ? d.title : "Conversation",
      participants,
      messages,
    };
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run, verify pass.** **Step 5: Commit** — `git commit -am "feat: add parseInbox DM parser with tests"`

---

## PHASE 3 — Connectors + ingest route

### Task 7: Connector interface + ExportConnector

**Files:** Create `src/lib/connectors/types.ts`, `src/lib/connectors/export-connector.ts`, `src/lib/connectors/messaging-api.ts`

- [ ] **Step 1: `types.ts`**

```typescript
export interface IngestResult {
  itemsAdded: number;
  conversationsAdded: number;
  messagesAdded: number;
  skipped: number;
}
export interface Connector {
  name: string;
  ingest(input: ArrayBuffer): Promise<IngestResult>;
}
```

- [ ] **Step 2: `export-connector.ts`** — unzip with `fflate`, route files, upsert via db + raw inserts.

```typescript
import { unzipSync, strFromU8 } from "fflate";
import { Connector, IngestResult } from "./types";
import { parseSavedPosts, parseInbox } from "../instagram-export";
import { detectSource } from "../metadata";
import { supabase } from "../supabase";
import { upsertItem } from "../db";

export class ExportConnector implements Connector {
  name = "instagram-export";

  async ingest(input: ArrayBuffer): Promise<IngestResult> {
    const files = unzipSync(new Uint8Array(input));
    const res: IngestResult = { itemsAdded: 0, conversationsAdded: 0, messagesAdded: 0, skipped: 0 };

    for (const [path, bytes] of Object.entries(files)) {
      try {
        if (/saved_posts\.json$/i.test(path)) {
          for (const p of parseSavedPosts(strFromU8(bytes))) {
            await upsertItem({
              url: p.url, source: detectSource(p.url),
              title: p.author ? `Saved from ${p.author}` : "Saved reel",
              author: p.author ?? null, thumbnail: null, summary: null,
              category: "Imported", tags: [], notes: null, origin: "saved",
            });
            res.itemsAdded++;
          }
        } else if (/messages\/inbox\/.+\/message_\d+\.json$/i.test(path)) {
          const t = parseInbox(strFromU8(bytes));
          if (!t) { res.skipped++; continue; }
          const { data: conv } = await supabase.from("conversations")
            .upsert({
              thread_key: t.threadKey, title: t.title, participants: t.participants,
              last_message_at: t.messages.length
                ? new Date(Math.max(...t.messages.map(m => m.sentAt))).toISOString() : null,
            }, { onConflict: "thread_key" }).select().single();
          if (!conv) { res.skipped++; continue; }
          res.conversationsAdded++;
          for (const m of t.messages) {
            const { error } = await supabase.from("messages").upsert({
              conversation_id: conv.id, external_id: m.externalId, sender: m.sender,
              content: m.content ?? null, sent_at: new Date(m.sentAt).toISOString(),
              shared_url: m.sharedUrl ?? null,
            }, { onConflict: "conversation_id,external_id", ignoreDuplicates: true });
            if (!error) res.messagesAdded++;
            if (m.sharedUrl) {
              await upsertItem({
                url: m.sharedUrl, source: detectSource(m.sharedUrl),
                title: `Shared by ${m.sender}`, author: m.sender, thumbnail: null,
                summary: null, category: "Shared in DMs", tags: [], notes: null, origin: "dm_shared",
              }).then(() => { res.itemsAdded++; }).catch(() => {});
            }
          }
        }
      } catch { res.skipped++; }
    }
    return res;
  }
}
```

- [ ] **Step 3: `messaging-api.ts`** (stub)

```typescript
import { Connector, IngestResult } from "./types";
export class MessagingApiConnector implements Connector {
  name = "instagram-messaging-api";
  async ingest(): Promise<IngestResult> {
    throw new Error("MessagingApiConnector not configured: requires a business account + Meta App Review.");
  }
}
```

- [ ] **Step 4: Commit** — `git add src/lib/connectors && git commit -m "feat: add ingest connectors (export + api stub)"`

### Task 8: Ingest API route

**Files:** Create `src/app/api/ingest/route.ts`

- [ ] **Step 1: Implement**

```typescript
import { NextRequest, NextResponse } from "next/server";
import { ExportConnector } from "@/lib/connectors/export-connector";

export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const buf = await req.arrayBuffer();
  if (!buf.byteLength) return NextResponse.json({ error: "empty body" }, { status: 400 });
  try {
    const result = await new ExportConnector().ingest(buf);
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
```

- [ ] **Step 2: Verify route compiles** (`npm run build` after Phase 4) and that middleware keeps it behind the passcode (it matches `/api/ingest`, not in the open allowlist). **Step 3: Commit** — `git add src/app/api/ingest && git commit -m "feat: add export-ZIP ingest route"`

---

## PHASE 4 — UI (use impeccable skill for visual quality)

> Build each surface with the `impeccable` frontend skill: cohesive design tokens, real visual hierarchy, polished cards/lists, dark-mode aware. Replace bare utility classes with a small shared design system in `globals.css` + a `Shell` layout component.

### Task 9: Server actions

**Files:** Create `src/app/actions.ts`

- [ ] **Step 1: Implement** thin server actions wrapping `db.ts`, marked `"use server"`:

```typescript
"use server";
import { revalidatePath } from "next/cache";
import * as db from "@/lib/db";
import { detectSource } from "@/lib/metadata";

export async function addManualItem(form: { url: string; title: string; summary?: string; category?: string; tags?: string[]; notes?: string }) {
  await db.upsertItem({
    url: form.url, source: detectSource(form.url), title: form.title || "Untitled",
    author: null, thumbnail: null, summary: form.summary ?? null,
    category: form.category || "Uncategorized", tags: form.tags ?? [], notes: form.notes ?? null,
    origin: "manual",
  });
  revalidatePath("/");
}
export async function saveNotes(id: string, notes: string) { await db.updateItem(id, { notes }); revalidatePath(`/item/${id}`); }
export async function deleteItem(id: string) { await db.removeItem(id); revalidatePath("/"); }
```

- [ ] **Step 2: Commit** — `git add src/app/actions.ts && git commit -m "feat: add server actions over Supabase"`

### Task 10: Dashboard (server component) + ItemCard/ItemGrid/SearchBar/Shell

**Files:** Rewrite `src/app/page.tsx`, `src/components/ItemCard.tsx`, `src/components/ItemGrid.tsx`; Create `src/components/Shell.tsx`, `src/components/SearchBar.tsx`

- [ ] **Step 1:** `page.tsx` is an async server component: reads `db.listItems()` (and `db.searchItems` when `?q=` present), derives categories, renders `Shell` + `SearchBar` + `ItemGrid`. `ItemCard`/`ItemGrid` take the new `Item` type from `@/lib/db` (NOT a Convex `Doc`). Search via URL param `?q=` (form GET), no client Convex hook. Apply impeccable styling.
- [ ] **Step 2:** Build passes for `/`. **Step 3: Commit** — `git commit -am "feat: Supabase-backed dashboard + components"`

### Task 11: Item detail

**Files:** Rewrite `src/app/item/[id]/page.tsx`

- [ ] **Step 1:** Async server component reads `db.getItem(id)`; notes save + delete use the `saveNotes`/`deleteItem` server actions via a small client form child component. Remove all Convex imports.
- [ ] **Step 2:** Build passes. **Step 3: Commit** — `git commit -am "feat: Supabase-backed item detail"`

### Task 12: Messages — conversation list + thread view

**Files:** Create `src/app/messages/page.tsx`, `src/app/messages/[id]/page.tsx`, `src/components/ConversationList.tsx`, `src/components/MessageThread.tsx`

- [ ] **Step 1:** `messages/page.tsx` reads `db.listConversations()` → `ConversationList` (title, participants, last_message_at). `messages/[id]/page.tsx` reads `db.getConversation(id)` → `MessageThread` rendering bubbles by sender; messages with `shared_url` render an inline reel card linking to `/item` if promoted, else the raw url. Impeccable chat styling.
- [ ] **Step 2:** Build passes. **Step 3: Commit** — `git commit -am "feat: DM conversation list + thread view"`

### Task 13: Ingest page (drag-drop ZIP)

**Files:** Create `src/app/ingest/page.tsx`

- [ ] **Step 1:** Client component: drag-drop or file input for `.zip`; on drop, `fetch('/api/ingest', { method:'POST', body: file })`; show progress + the returned counts (`itemsAdded`, `conversationsAdded`, `messagesAdded`, `skipped`). Link from `Shell` nav. Replaces the old `/import` page (delete `src/app/import/page.tsx`).
- [ ] **Step 2:** Build passes. **Step 3: Commit** — `git commit -am "feat: ZIP ingest page"`

### Task 14: Replace add page

**Files:** Rewrite `src/app/add/page.tsx`, delete `src/components/ReviewForm.tsx` if unused

- [ ] **Step 1:** `/add` becomes a client form that fetches `/api/metadata`, optionally `/api/enrich`, then calls the `addManualItem` server action (no Convex `useMutation`/`useConvex`). Keep dedup by attempting upsert (url is unique).
- [ ] **Step 2:** Build passes. **Step 3: Commit** — `git commit -am "feat: Supabase-backed add flow"`

---

## PHASE 5 — AI enrichment (background)

### Task 15: Enrich-after-ingest action

**Files:** Create `src/app/api/enrich-pending/route.ts`

- [ ] **Step 1:** POST route: select up to N items where `summary is null` (and origin in saved/dm_shared), call the existing `/lib/ai.ts` `buildEnrichPrompt` + Claude (reuse logic from `api/enrich/route.ts`), `db.updateItem` with summary/category/tags. Returns count enriched. Idempotent, safe to call repeatedly. Triggered by a button on the ingest page after upload (so thousands of items don't block ingest).

```typescript
import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { supabase } from "@/lib/supabase";
import { buildEnrichPrompt, parseEnrichResponse } from "@/lib/ai";
import { updateItem } from "@/lib/db";

export const maxDuration = 300;

export async function POST() {
  if (!process.env.ANTHROPIC_API_KEY) return NextResponse.json({ enriched: 0 });
  const { data: pending } = await supabase.from("items").select("*").is("summary", null).limit(20);
  if (!pending?.length) return NextResponse.json({ enriched: 0 });
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  let enriched = 0;
  for (const it of pending) {
    try {
      const msg = await client.messages.create({
        model: "claude-haiku-4-5-20251001", max_tokens: 300,
        messages: [{ role: "user", content: buildEnrichPrompt(it.title ?? "", it.notes ?? "") }],
      });
      const text = msg.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");
      const e = parseEnrichResponse(text);
      await updateItem(it.id, { summary: e.summary || null, category: e.category || it.category, tags: e.tags });
      enriched++;
    } catch { /* skip */ }
  }
  return NextResponse.json({ enriched });
}
```

- [ ] **Step 2: Commit** — `git add src/app/api/enrich-pending && git commit -m "feat: background AI enrichment for ingested items"`

---

## PHASE 6 — Verify

### Task 16: Full verification

- [ ] **Step 1:** `npm test` → all parser tests pass (`metadata`, `ai`, `instagram-export` incl. `parseInbox`).
- [ ] **Step 2:** `npm run build` → succeeds, routes include `/`, `/add`, `/ingest`, `/messages`, `/messages/[id]`, `/item/[id]`, `/api/ingest`, `/api/enrich-pending`, `/login`.
- [ ] **Step 3:** Schema reachable: the `curl` PostgREST check from Task 2 returns 200.
- [ ] **Step 4:** Manual (cannot automate headless), report honestly: upload a real export ZIP on `/ingest`; confirm items + conversations appear; run enrich; search across items + messages.
- [ ] **Step 5: Commit** any fixes.

---

## Self-Review Notes

- **Spec coverage:** Supabase backend (Tasks 1-4); Convex removal (Task 5); DM parser (Task 6); pluggable connectors (Task 7); ZIP ingest (Tasks 7-8, 13); saved + DM scope (parser + connector); AI enrich (Task 15); UI dashboard/messages/search/detail (Tasks 9-14); migration of pure libs (kept, extended Task 6).
- **Type consistency:** `Item`/`NewItem`/`Conversation`/`Message` defined once in `db.ts`; `ParsedThread`/`ParsedMessage` in `instagram-export.ts`; `IngestResult`/`Connector` in `connectors/types.ts`; components consume `Item` from `db.ts` (not Convex `Doc`).
- **Known infra risk:** applying SQL + exposing the `reel_vault` schema to PostgREST is the one step that may need the Supabase dashboard or MCP `apply_migration` if `db push` can't auth non-interactively (Task 2 note). Resolve before Phase 4 UI is testable end-to-end.
- **Out of scope:** live Messaging API (stub), multi-user, media re-hosting.
