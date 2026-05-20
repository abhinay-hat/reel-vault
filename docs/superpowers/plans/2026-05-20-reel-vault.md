# Reel Vault Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a personal, single-user web app that captures Instagram reels and articles, enriches them with AI-generated summaries and tags, and makes them browsable and searchable.

**Architecture:** Next.js (App Router) frontend with a Convex backend for database, queries, and mutations. URL metadata is fetched server-side via Instagram oEmbed and OpenGraph tags. AI enrichment calls the Claude API. The app deploys to Vercel (frontend) and Convex Cloud (backend); HTTPS enables PWA install and Web Share Target capture.

**Tech Stack:** Next.js 15 (App Router, TypeScript), Convex, Tailwind CSS, Vitest, `@anthropic-ai/sdk`.

---

## File Structure

```
reel-vault/
  convex/
    schema.ts              Convex tables + search index
    items.ts               queries + mutations for items
  src/
    app/
      layout.tsx           root layout, ConvexProvider, manifest link
      page.tsx             dashboard (grid, filter, search)
      add/page.tsx         add flow (fetch metadata, AI review, save)
      item/[id]/page.tsx   item detail (embed + notes)
      bookmarklet/page.tsx bookmarklet install page
      api/
        metadata/route.ts  GET ?url= -> {title,author,thumbnail,caption}
        enrich/route.ts    POST {title,caption} -> {summary,category,tags}
        import/route.ts     POST DYI zip -> bulk insert
    components/
      ConvexClientProvider.tsx
      ItemCard.tsx
      ItemGrid.tsx
      ReviewForm.tsx
    lib/
      metadata.ts          parseOembed, parseOpenGraph (pure)
      ai.ts                buildEnrichPrompt, parseEnrichResponse (pure)
      instagram-export.ts  parseSavedPosts (pure)
      passcode.ts          passcode check helper
    middleware.ts          passcode gate
  public/
    manifest.json          PWA manifest with share_target
  vitest.config.ts
  .env.local               secrets (gitignored)
```

---

## PHASE 1 — Scaffold, schema, paste-add, dashboard, passcode

### Task 1: Scaffold Next.js project

**Files:**
- Create: whole project tree

- [ ] **Step 1: Create the Next.js app in place**

The project folder and git repo already exist. Run from `reel-vault/`:

```bash
npx create-next-app@latest . --typescript --tailwind --app --src-dir --import-alias "@/*" --no-eslint --use-npm
```

When prompted to proceed in a non-empty directory, choose yes; it preserves `docs/` and `.git/`.

- [ ] **Step 2: Verify dev server starts**

Run: `npm run dev`
Expected: server on `http://localhost:3000`, default page renders. Stop with Ctrl-C.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "chore: scaffold Next.js app"
```

### Task 2: Set up Vitest

**Files:**
- Create: `vitest.config.ts`
- Modify: `package.json` (add `test` script)

- [ ] **Step 1: Install Vitest**

```bash
npm install -D vitest
```

- [ ] **Step 2: Create `vitest.config.ts`**

```typescript
import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: { environment: "node" },
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
});
```

- [ ] **Step 3: Add test script to `package.json`**

In the `"scripts"` object add: `"test": "vitest run"`

- [ ] **Step 4: Verify Vitest runs**

Run: `npm test`
Expected: exits 0 with "No test files found" (acceptable — no tests yet).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: add Vitest"
```

### Task 3: Initialize Convex and define schema

**Files:**
- Create: `convex/schema.ts`

- [ ] **Step 1: Install and init Convex**

```bash
npm install convex
npx convex dev --once
```

This prompts a browser login and creates a Convex project; it writes `CONVEX_DEPLOYMENT` and `NEXT_PUBLIC_CONVEX_URL` into `.env.local`. Leave `.env.local` gitignored.

- [ ] **Step 2: Create `convex/schema.ts`**

```typescript
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  items: defineTable({
    url: v.string(),
    source: v.union(v.literal("instagram"), v.literal("article"), v.literal("other")),
    title: v.string(),
    author: v.optional(v.string()),
    thumbnail: v.optional(v.string()),
    summary: v.optional(v.string()),
    category: v.string(),
    tags: v.array(v.string()),
    notes: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_url", ["url"])
    .index("by_category", ["category"])
    .searchIndex("search_title", {
      searchField: "title",
      filterFields: ["category"],
    }),
});
```

- [ ] **Step 3: Push schema**

Run: `npx convex dev --once`
Expected: "Convex functions ready", schema deployed without errors.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: add Convex schema for items"
```

### Task 4: Convex items functions

**Files:**
- Create: `convex/items.ts`

- [ ] **Step 1: Create `convex/items.ts`**

```typescript
import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

const sourceValidator = v.union(
  v.literal("instagram"),
  v.literal("article"),
  v.literal("other"),
);

export const add = mutation({
  args: {
    url: v.string(),
    source: sourceValidator,
    title: v.string(),
    author: v.optional(v.string()),
    thumbnail: v.optional(v.string()),
    summary: v.optional(v.string()),
    category: v.string(),
    tags: v.array(v.string()),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("items", { ...args, createdAt: Date.now() });
  },
});

export const update = mutation({
  args: {
    id: v.id("items"),
    title: v.optional(v.string()),
    summary: v.optional(v.string()),
    category: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, { id, ...patch }) => {
    const clean = Object.fromEntries(
      Object.entries(patch).filter(([, x]) => x !== undefined),
    );
    await ctx.db.patch(id, clean);
  },
});

export const remove = mutation({
  args: { id: v.id("items") },
  handler: async (ctx, { id }) => {
    await ctx.db.delete(id);
  },
});

export const list = query({
  args: { category: v.optional(v.string()) },
  handler: async (ctx, { category }) => {
    if (category) {
      return await ctx.db
        .query("items")
        .withIndex("by_category", (q) => q.eq("category", category))
        .order("desc")
        .collect();
    }
    return await ctx.db.query("items").order("desc").collect();
  },
});

export const get = query({
  args: { id: v.id("items") },
  handler: async (ctx, { id }) => await ctx.db.get(id),
});

export const findByUrl = query({
  args: { url: v.string() },
  handler: async (ctx, { url }) => {
    return await ctx.db
      .query("items")
      .withIndex("by_url", (q) => q.eq("url", url))
      .first();
  },
});

export const search = query({
  args: { text: v.string() },
  handler: async (ctx, { text }) => {
    if (!text.trim()) return [];
    return await ctx.db
      .query("items")
      .withSearchIndex("search_title", (q) => q.search("title", text))
      .take(50);
  },
});
```

- [ ] **Step 2: Push and verify**

Run: `npx convex dev --once`
Expected: functions compile, no type errors.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: add Convex items queries and mutations"
```

### Task 5: Convex client provider

**Files:**
- Create: `src/components/ConvexClientProvider.tsx`
- Modify: `src/app/layout.tsx`

- [ ] **Step 1: Create `src/components/ConvexClientProvider.tsx`**

```typescript
"use client";

import { ConvexProvider, ConvexReactClient } from "convex/react";
import { ReactNode } from "react";

const convex = new ConvexReactClient(process.env.NEXT_PUBLIC_CONVEX_URL!);

export function ConvexClientProvider({ children }: { children: ReactNode }) {
  return <ConvexProvider client={convex}>{children}</ConvexProvider>;
}
```

- [ ] **Step 2: Wrap the app in `src/app/layout.tsx`**

Replace the `<body>` contents so children are wrapped:

```tsx
import { ConvexClientProvider } from "@/components/ConvexClientProvider";
// ...existing imports and metadata...

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <ConvexClientProvider>{children}</ConvexClientProvider>
      </body>
    </html>
  );
}
```

- [ ] **Step 3: Verify the app still builds**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: wire ConvexProvider into layout"
```

### Task 6: Metadata parser (pure functions, TDD)

**Files:**
- Create: `src/lib/metadata.ts`
- Test: `src/lib/metadata.test.ts`

- [ ] **Step 1: Write the failing test in `src/lib/metadata.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import { parseOembed, parseOpenGraph, detectSource } from "./metadata";

describe("parseOembed", () => {
  it("extracts title, author, thumbnail", () => {
    const json = {
      title: "How to edit a video",
      author_name: "creator123",
      thumbnail_url: "https://cdn/thumb.jpg",
    };
    expect(parseOembed(json)).toEqual({
      title: "How to edit a video",
      author: "creator123",
      thumbnail: "https://cdn/thumb.jpg",
      caption: "How to edit a video",
    });
  });
});

describe("parseOpenGraph", () => {
  it("extracts og tags from html", () => {
    const html = `<html><head>
      <meta property="og:title" content="Color grading basics" />
      <meta property="og:image" content="https://cdn/og.jpg" />
      <meta property="og:description" content="A short guide" />
    </head></html>`;
    expect(parseOpenGraph(html)).toEqual({
      title: "Color grading basics",
      author: undefined,
      thumbnail: "https://cdn/og.jpg",
      caption: "A short guide",
    });
  });

  it("falls back to <title> when og:title missing", () => {
    const html = `<html><head><title>Fallback Title</title></head></html>`;
    expect(parseOpenGraph(html).title).toBe("Fallback Title");
  });
});

describe("detectSource", () => {
  it("classifies instagram urls", () => {
    expect(detectSource("https://www.instagram.com/reel/abc/")).toBe("instagram");
  });
  it("classifies other urls as article", () => {
    expect(detectSource("https://example.com/post")).toBe("article");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/lib/metadata.test.ts`
Expected: FAIL — cannot find module `./metadata`.

- [ ] **Step 3: Implement `src/lib/metadata.ts`**

```typescript
export interface Metadata {
  title: string;
  author?: string;
  thumbnail?: string;
  caption?: string;
}

export function parseOembed(json: {
  title?: string;
  author_name?: string;
  thumbnail_url?: string;
}): Metadata {
  return {
    title: json.title ?? "Untitled",
    author: json.author_name,
    thumbnail: json.thumbnail_url,
    caption: json.title,
  };
}

function metaContent(html: string, property: string): string | undefined {
  const re = new RegExp(
    `<meta[^>]+(?:property|name)=["']${property}["'][^>]*content=["']([^"']*)["']`,
    "i",
  );
  const m = html.match(re);
  return m ? m[1] : undefined;
}

export function parseOpenGraph(html: string): Metadata {
  const ogTitle = metaContent(html, "og:title");
  const tagTitle = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1];
  return {
    title: ogTitle ?? tagTitle ?? "Untitled",
    author: metaContent(html, "article:author") ?? metaContent(html, "author"),
    thumbnail: metaContent(html, "og:image"),
    caption: metaContent(html, "og:description"),
  };
}

export type Source = "instagram" | "article" | "other";

export function detectSource(url: string): Source {
  if (/instagram\.com/i.test(url)) return "instagram";
  try {
    new URL(url);
    return "article";
  } catch {
    return "other";
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/lib/metadata.test.ts`
Expected: PASS — all 5 tests green.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add metadata parsers with tests"
```

### Task 7: Metadata API route

**Files:**
- Create: `src/app/api/metadata/route.ts`

- [ ] **Step 1: Create `src/app/api/metadata/route.ts`**

```typescript
import { NextRequest, NextResponse } from "next/server";
import { parseOembed, parseOpenGraph, detectSource } from "@/lib/metadata";

export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get("url");
  if (!url) {
    return NextResponse.json({ error: "missing url" }, { status: 400 });
  }
  const source = detectSource(url);

  if (source === "instagram") {
    const oembedUrl = `https://api.instagram.com/oembed/?url=${encodeURIComponent(url)}`;
    try {
      const res = await fetch(oembedUrl);
      if (res.ok) {
        return NextResponse.json({ ...parseOembed(await res.json()), source });
      }
    } catch {
      // fall through to OpenGraph
    }
  }

  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; ReelVault/1.0)" },
    });
    const html = await res.text();
    return NextResponse.json({ ...parseOpenGraph(html), source });
  } catch {
    return NextResponse.json(
      { title: "", author: null, thumbnail: null, caption: "", source },
      { status: 200 },
    );
  }
}
```

Note: Instagram oEmbed without an app token is unreliable; the OpenGraph fallback is the resilient path, and the add form is always editable, so a failed fetch never blocks a save.

- [ ] **Step 2: Verify the route responds**

Run `npm run dev`, then in another shell:
`curl "http://localhost:3000/api/metadata?url=https://example.com"`
Expected: JSON with a `title` and `source: "article"`.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: add metadata fetch API route"
```

### Task 8: Passcode gate

**Files:**
- Create: `src/lib/passcode.ts`
- Create: `src/middleware.ts`
- Create: `src/app/login/page.tsx`
- Create: `src/app/api/login/route.ts`
- Modify: `.env.local` (add `APP_PASSCODE`)

- [ ] **Step 1: Add the passcode to `.env.local`**

Append: `APP_PASSCODE=change-me-now`

- [ ] **Step 2: Create `src/lib/passcode.ts`**

```typescript
export const PASSCODE_COOKIE = "rv_auth";

export function isValidPasscode(input: string): boolean {
  const expected = process.env.APP_PASSCODE;
  return !!expected && input === expected;
}
```

- [ ] **Step 3: Create `src/middleware.ts`**

```typescript
import { NextRequest, NextResponse } from "next/server";
import { PASSCODE_COOKIE } from "@/lib/passcode";

export function middleware(req: NextRequest) {
  const authed = req.cookies.get(PASSCODE_COOKIE)?.value === "ok";
  const isLogin =
    req.nextUrl.pathname === "/login" ||
    req.nextUrl.pathname === "/api/login";
  if (!authed && !isLogin) {
    return NextResponse.redirect(new URL("/login", req.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|manifest.json).*)"],
};
```

- [ ] **Step 4: Create `src/app/api/login/route.ts`**

```typescript
import { NextRequest, NextResponse } from "next/server";
import { isValidPasscode, PASSCODE_COOKIE } from "@/lib/passcode";

export async function POST(req: NextRequest) {
  const { passcode } = await req.json();
  if (!isValidPasscode(passcode)) {
    return NextResponse.json({ error: "wrong passcode" }, { status: 401 });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(PASSCODE_COOKIE, "ok", {
    httpOnly: true,
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 365,
    path: "/",
  });
  return res;
}
```

- [ ] **Step 5: Create `src/app/login/page.tsx`**

```tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const [passcode, setPasscode] = useState("");
  const [error, setError] = useState("");
  const router = useRouter();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ passcode }),
    });
    if (res.ok) router.push("/");
    else setError("Wrong passcode");
  }

  return (
    <main className="flex min-h-screen items-center justify-center">
      <form onSubmit={submit} className="flex flex-col gap-3 w-64">
        <h1 className="text-xl font-bold">Reel Vault</h1>
        <input
          type="password"
          value={passcode}
          onChange={(e) => setPasscode(e.target.value)}
          placeholder="Passcode"
          className="border rounded px-3 py-2"
        />
        {error && <p className="text-red-600 text-sm">{error}</p>}
        <button className="bg-black text-white rounded px-3 py-2">Enter</button>
      </form>
    </main>
  );
}
```

- [ ] **Step 6: Verify the gate works**

Run `npm run dev`, open `http://localhost:3000`. Expected: redirect to `/login`. Enter the passcode → redirect to `/`.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: add single-user passcode gate"
```

### Task 9: ItemCard and ItemGrid components

**Files:**
- Create: `src/components/ItemCard.tsx`
- Create: `src/components/ItemGrid.tsx`

- [ ] **Step 1: Create `src/components/ItemCard.tsx`**

```tsx
import Link from "next/link";
import { Doc } from "../../convex/_generated/dataModel";

export function ItemCard({ item }: { item: Doc<"items"> }) {
  return (
    <Link
      href={`/item/${item._id}`}
      className="block rounded-lg overflow-hidden border hover:shadow-md transition"
    >
      {item.thumbnail ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={item.thumbnail}
          alt={item.title}
          className="w-full h-44 object-cover"
        />
      ) : (
        <div className="w-full h-44 bg-gray-100" />
      )}
      <div className="p-2">
        <span className="text-xs bg-gray-200 rounded px-2 py-0.5">
          {item.category}
        </span>
        <p className="mt-1 text-sm font-medium line-clamp-2">{item.title}</p>
      </div>
    </Link>
  );
}
```

- [ ] **Step 2: Create `src/components/ItemGrid.tsx`**

```tsx
import { Doc } from "../../convex/_generated/dataModel";
import { ItemCard } from "./ItemCard";

export function ItemGrid({ items }: { items: Doc<"items">[] }) {
  if (items.length === 0) {
    return <p className="text-gray-500 mt-8">Nothing here yet.</p>;
  }
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      {items.map((item) => (
        <ItemCard key={item._id} item={item} />
      ))}
    </div>
  );
}
```

- [ ] **Step 3: Verify the build**

Run: `npm run build`
Expected: build succeeds (components are unused so far — acceptable).

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: add ItemCard and ItemGrid components"
```

### Task 10: Dashboard page with search and filter

**Files:**
- Modify: `src/app/page.tsx`

- [ ] **Step 1: Replace `src/app/page.tsx`**

```tsx
"use client";

import { useState } from "react";
import { useQuery } from "convex/react";
import Link from "next/link";
import { api } from "../../convex/_generated/api";
import { ItemGrid } from "@/components/ItemGrid";

export default function Dashboard() {
  const [text, setText] = useState("");
  const [category, setCategory] = useState<string | undefined>(undefined);

  const all = useQuery(api.items.list, { category });
  const found = useQuery(api.items.search, { text });

  const items = text.trim() ? found : all;
  const categories = Array.from(
    new Set((all ?? []).map((i) => i.category)),
  ).sort();

  return (
    <main className="max-w-5xl mx-auto p-4">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold">Reel Vault</h1>
        <Link
          href="/add"
          className="bg-black text-white rounded px-3 py-1.5 text-sm"
        >
          + Add
        </Link>
      </div>

      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Search title, summary, tags…"
        className="w-full border rounded px-3 py-2 mb-3"
      />

      <div className="flex gap-2 flex-wrap mb-4">
        <button
          onClick={() => setCategory(undefined)}
          className={`text-xs rounded px-2 py-1 border ${!category ? "bg-black text-white" : ""}`}
        >
          All
        </button>
        {categories.map((c) => (
          <button
            key={c}
            onClick={() => setCategory(c)}
            className={`text-xs rounded px-2 py-1 border ${category === c ? "bg-black text-white" : ""}`}
          >
            {c}
          </button>
        ))}
      </div>

      {items === undefined ? (
        <p className="text-gray-500">Loading…</p>
      ) : (
        <ItemGrid items={items} />
      )}
    </main>
  );
}
```

Note: full search across summary/tags/notes is added in Task 11; this task wires the title search index.

- [ ] **Step 2: Verify the dashboard renders**

Run `npm run dev`, log in, open `/`. Expected: "Reel Vault" header, search box, "Nothing here yet."

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: add dashboard with search and category filter"
```

### Task 11: Extend search to summary, tags, and notes

**Files:**
- Modify: `convex/items.ts` (`search` query)

- [ ] **Step 1: Replace the `search` query in `convex/items.ts`**

```typescript
export const search = query({
  args: { text: v.string() },
  handler: async (ctx, { text }) => {
    const term = text.trim().toLowerCase();
    if (!term) return [];
    const all = await ctx.db.query("items").order("desc").collect();
    return all.filter((i) => {
      const hay = [
        i.title,
        i.summary ?? "",
        i.notes ?? "",
        i.tags.join(" "),
        i.category,
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(term);
    });
  },
});
```

Rationale: the dataset is personal-scale (hundreds of items), so an in-memory substring filter across all fields is simpler and more complete than juggling multiple search indexes. The `search_title` index in the schema stays for possible future use.

- [ ] **Step 2: Push and verify**

Run: `npx convex dev --once`
Expected: compiles without errors.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: search across summary, tags, and notes"
```

### Task 12: Add page — paste URL, fetch metadata, manual save

**Files:**
- Create: `src/app/add/page.tsx`
- Create: `src/components/ReviewForm.tsx`

- [ ] **Step 1: Create `src/components/ReviewForm.tsx`**

```tsx
"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { useRouter } from "next/navigation";
import { api } from "../../convex/_generated/api";
import { Source } from "@/lib/metadata";

export interface ReviewDraft {
  url: string;
  source: Source;
  title: string;
  author?: string;
  thumbnail?: string;
  summary: string;
  category: string;
  tags: string[];
  notes: string;
}

export function ReviewForm({ draft }: { draft: ReviewDraft }) {
  const [d, setD] = useState<ReviewDraft>(draft);
  const [saving, setSaving] = useState(false);
  const add = useMutation(api.items.add);
  const router = useRouter();

  async function save() {
    setSaving(true);
    await add({
      url: d.url,
      source: d.source,
      title: d.title || "Untitled",
      author: d.author,
      thumbnail: d.thumbnail,
      summary: d.summary || undefined,
      category: d.category || "Uncategorized",
      tags: d.tags,
      notes: d.notes || undefined,
    });
    router.push("/");
  }

  const field = "border rounded px-3 py-2 w-full";

  return (
    <div className="flex flex-col gap-3">
      <input
        className={field}
        value={d.title}
        onChange={(e) => setD({ ...d, title: e.target.value })}
        placeholder="Title"
      />
      <textarea
        className={field}
        value={d.summary}
        onChange={(e) => setD({ ...d, summary: e.target.value })}
        placeholder="Summary"
        rows={3}
      />
      <input
        className={field}
        value={d.category}
        onChange={(e) => setD({ ...d, category: e.target.value })}
        placeholder="Category"
      />
      <input
        className={field}
        value={d.tags.join(", ")}
        onChange={(e) =>
          setD({
            ...d,
            tags: e.target.value
              .split(",")
              .map((t) => t.trim())
              .filter(Boolean),
          })
        }
        placeholder="Tags (comma separated)"
      />
      <textarea
        className={field}
        value={d.notes}
        onChange={(e) => setD({ ...d, notes: e.target.value })}
        placeholder="Your notes"
        rows={3}
      />
      <button
        disabled={saving}
        onClick={save}
        className="bg-black text-white rounded px-3 py-2 disabled:opacity-50"
      >
        {saving ? "Saving…" : "Save"}
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Create `src/app/add/page.tsx`**

```tsx
"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ReviewForm, ReviewDraft } from "@/components/ReviewForm";
import { Source } from "@/lib/metadata";

function AddInner() {
  const params = useSearchParams();
  const sharedUrl = params.get("url") ?? params.get("text") ?? "";
  const [url, setUrl] = useState(sharedUrl);
  const [draft, setDraft] = useState<ReviewDraft | null>(null);
  const [loading, setLoading] = useState(false);

  async function fetchMeta(target: string) {
    setLoading(true);
    const res = await fetch(`/api/metadata?url=${encodeURIComponent(target)}`);
    const m = await res.json();
    setDraft({
      url: target,
      source: (m.source as Source) ?? "other",
      title: m.title ?? "",
      author: m.author ?? undefined,
      thumbnail: m.thumbnail ?? undefined,
      summary: "",
      category: "",
      tags: [],
      notes: "",
    });
    setLoading(false);
  }

  useEffect(() => {
    if (sharedUrl) fetchMeta(sharedUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sharedUrl]);

  return (
    <main className="max-w-lg mx-auto p-4">
      <h1 className="text-xl font-bold mb-4">Add to Reel Vault</h1>
      {!draft && (
        <div className="flex gap-2 mb-4">
          <input
            className="border rounded px-3 py-2 flex-1"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="Paste a reel or article URL"
          />
          <button
            onClick={() => fetchMeta(url)}
            disabled={!url || loading}
            className="bg-black text-white rounded px-3 py-2 disabled:opacity-50"
          >
            {loading ? "…" : "Fetch"}
          </button>
        </div>
      )}
      {draft && <ReviewForm draft={draft} />}
    </main>
  );
}

export default function AddPage() {
  return (
    <Suspense fallback={<p className="p-4">Loading…</p>}>
      <AddInner />
    </Suspense>
  );
}
```

- [ ] **Step 3: Verify the add flow end to end**

Run `npm run dev`, log in, go to `/add`, paste `https://example.com`, click Fetch, fill category, Save. Expected: redirect to `/`, the item appears in the grid.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: add page with paste-URL capture and review form"
```

### Task 13: Item detail page with embed and notes

**Files:**
- Create: `src/app/item/[id]/page.tsx`

- [ ] **Step 1: Create `src/app/item/[id]/page.tsx`**

```tsx
"use client";

import { use, useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { useRouter } from "next/navigation";
import { api } from "../../../../convex/_generated/api";
import { Id } from "../../../../convex/_generated/dataModel";

export default function ItemDetail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const item = useQuery(api.items.get, { id: id as Id<"items"> });
  const update = useMutation(api.items.update);
  const remove = useMutation(api.items.remove);
  const router = useRouter();
  const [notes, setNotes] = useState<string | null>(null);

  if (item === undefined) return <p className="p-4">Loading…</p>;
  if (item === null) return <p className="p-4">Not found.</p>;

  const noteValue = notes ?? item.notes ?? "";

  return (
    <main className="max-w-lg mx-auto p-4 flex flex-col gap-3">
      <button onClick={() => router.push("/")} className="text-sm text-left">
        ← Back
      </button>
      <h1 className="text-xl font-bold">{item.title}</h1>
      {item.thumbnail && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={item.thumbnail} alt={item.title} className="rounded" />
      )}
      <a
        href={item.url}
        target="_blank"
        rel="noreferrer"
        className="text-blue-600 underline text-sm break-all"
      >
        Open original ↗
      </a>
      {item.summary && <p className="text-sm text-gray-700">{item.summary}</p>}
      <div className="flex gap-1 flex-wrap">
        <span className="text-xs bg-gray-200 rounded px-2 py-0.5">
          {item.category}
        </span>
        {item.tags.map((t) => (
          <span key={t} className="text-xs bg-gray-100 rounded px-2 py-0.5">
            #{t}
          </span>
        ))}
      </div>
      <textarea
        className="border rounded px-3 py-2"
        rows={4}
        value={noteValue}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="Your notes"
      />
      <div className="flex gap-2">
        <button
          onClick={() => update({ id: item._id, notes: noteValue })}
          className="bg-black text-white rounded px-3 py-2 text-sm"
        >
          Save notes
        </button>
        <button
          onClick={async () => {
            await remove({ id: item._id });
            router.push("/");
          }}
          className="border border-red-500 text-red-600 rounded px-3 py-2 text-sm"
        >
          Delete
        </button>
      </div>
    </main>
  );
}
```

- [ ] **Step 2: Verify the detail page**

Run `npm run dev`, click an item from the dashboard. Expected: detail view loads; editing notes and clicking "Save notes" persists; "Delete" removes the item and returns to `/`.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: add item detail page with notes and delete"
```

### Task 14: Duplicate detection on add

**Files:**
- Modify: `src/app/add/page.tsx` (`fetchMeta`)

- [ ] **Step 1: Update `fetchMeta` in `src/app/add/page.tsx`**

Add the Convex duplicate check. Add these imports at the top of the file:

```tsx
import { useConvex } from "convex/react";
import { api } from "../../../convex/_generated/api";
```

Add `const convex = useConvex();` inside `AddInner`, and replace `fetchMeta` with:

```tsx
async function fetchMeta(target: string) {
  setLoading(true);
  const existing = await convex.query(api.items.findByUrl, { url: target });
  if (existing) {
    setLoading(false);
    window.location.href = `/item/${existing._id}`;
    return;
  }
  const res = await fetch(`/api/metadata?url=${encodeURIComponent(target)}`);
  const m = await res.json();
  setDraft({
    url: target,
    source: (m.source as Source) ?? "other",
    title: m.title ?? "",
    author: m.author ?? undefined,
    thumbnail: m.thumbnail ?? undefined,
    summary: "",
    category: "",
    tags: [],
    notes: "",
  });
  setLoading(false);
}
```

- [ ] **Step 2: Verify dedup**

Run `npm run dev`, add a URL, then try `/add` with the same URL. Expected: redirect straight to the existing item's detail page.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: detect duplicate URLs on add"
```

---

## PHASE 2 — AI enrichment

### Task 15: AI prompt builder and response parser (pure, TDD)

**Files:**
- Create: `src/lib/ai.ts`
- Test: `src/lib/ai.test.ts`

- [ ] **Step 1: Write the failing test in `src/lib/ai.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import { buildEnrichPrompt, parseEnrichResponse } from "./ai";

describe("buildEnrichPrompt", () => {
  it("includes title and caption", () => {
    const p = buildEnrichPrompt("Edit a video", "Step by step tutorial");
    expect(p).toContain("Edit a video");
    expect(p).toContain("Step by step tutorial");
  });
});

describe("parseEnrichResponse", () => {
  it("parses a clean JSON object", () => {
    const raw = '{"summary":"A tutorial","category":"Video Editing","tags":["editing","tutorial"]}';
    expect(parseEnrichResponse(raw)).toEqual({
      summary: "A tutorial",
      category: "Video Editing",
      tags: ["editing", "tutorial"],
    });
  });

  it("parses JSON wrapped in markdown fences", () => {
    const raw = '```json\n{"summary":"x","category":"y","tags":[]}\n```';
    expect(parseEnrichResponse(raw)).toEqual({
      summary: "x",
      category: "y",
      tags: [],
    });
  });

  it("returns empty defaults on invalid JSON", () => {
    expect(parseEnrichResponse("not json")).toEqual({
      summary: "",
      category: "",
      tags: [],
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/lib/ai.test.ts`
Expected: FAIL — cannot find module `./ai`.

- [ ] **Step 3: Implement `src/lib/ai.ts`**

```typescript
export interface Enrichment {
  summary: string;
  category: string;
  tags: string[];
}

export function buildEnrichPrompt(title: string, caption: string): string {
  return `You organize a personal knowledge base of saved tutorial reels and articles.
Given the item below, respond with ONLY a JSON object, no prose, with keys:
- "summary": one sentence, max 25 words
- "category": a short title-case category (e.g. "Video Editing", "Image Styles", "Photography")
- "tags": array of 2-5 short lowercase tags

Title: ${title}
Caption: ${caption}`;
}

export function parseEnrichResponse(raw: string): Enrichment {
  const empty: Enrichment = { summary: "", category: "", tags: [] };
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fenced ? fenced[1] : raw).trim();
  try {
    const obj = JSON.parse(body);
    return {
      summary: typeof obj.summary === "string" ? obj.summary : "",
      category: typeof obj.category === "string" ? obj.category : "",
      tags: Array.isArray(obj.tags)
        ? obj.tags.filter((t: unknown) => typeof t === "string")
        : [],
    };
  } catch {
    return empty;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/lib/ai.test.ts`
Expected: PASS — all 4 tests green.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add AI prompt builder and response parser with tests"
```

### Task 16: Enrich API route

**Files:**
- Create: `src/app/api/enrich/route.ts`
- Modify: `.env.local` (add `ANTHROPIC_API_KEY`)

- [ ] **Step 1: Install the Anthropic SDK**

```bash
npm install @anthropic-ai/sdk
```

- [ ] **Step 2: Add the API key to `.env.local`**

Append: `ANTHROPIC_API_KEY=sk-ant-...` (the user supplies the real key).

- [ ] **Step 3: Create `src/app/api/enrich/route.ts`**

```typescript
import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { buildEnrichPrompt, parseEnrichResponse } from "@/lib/ai";

export async function POST(req: NextRequest) {
  const { title, caption } = await req.json();
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ summary: "", category: "", tags: [] });
  }
  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const msg = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 300,
      messages: [
        { role: "user", content: buildEnrichPrompt(title ?? "", caption ?? "") },
      ],
    });
    const text = msg.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("");
    return NextResponse.json(parseEnrichResponse(text));
  } catch {
    return NextResponse.json({ summary: "", category: "", tags: [] });
  }
}
```

Rationale: enrichment is an assist, so any failure returns empty defaults and the user fills the fields manually — the route never errors out the add flow. Haiku keeps cost low for short classification.

- [ ] **Step 4: Verify the route responds**

Run `npm run dev`, then:
`curl -X POST http://localhost:3000/api/enrich -H "Content-Type: application/json" -d '{"title":"How to color grade","caption":"A tutorial on color grading in DaVinci Resolve"}'`
Expected: JSON with non-empty `summary`, `category`, `tags` (assuming a valid key).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add Claude enrichment API route"
```

### Task 17: Wire AI suggestions into the add flow

**Files:**
- Modify: `src/app/add/page.tsx` (`fetchMeta`)

- [ ] **Step 1: Update `fetchMeta` in `src/app/add/page.tsx`**

After fetching metadata, call the enrich route and seed the draft. Replace the draft-building portion of `fetchMeta` so it reads:

```tsx
const res = await fetch(`/api/metadata?url=${encodeURIComponent(target)}`);
const m = await res.json();

let enrich = { summary: "", category: "", tags: [] as string[] };
try {
  const er = await fetch("/api/enrich", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: m.title, caption: m.caption }),
  });
  if (er.ok) enrich = await er.json();
} catch {
  // enrichment is optional; keep empty defaults
}

setDraft({
  url: target,
  source: (m.source as Source) ?? "other",
  title: m.title ?? "",
  author: m.author ?? undefined,
  thumbnail: m.thumbnail ?? undefined,
  summary: enrich.summary,
  category: enrich.category,
  tags: enrich.tags,
  notes: "",
});
setLoading(false);
```

- [ ] **Step 2: Verify AI suggestions appear**

Run `npm run dev`, go to `/add`, fetch a real article URL. Expected: the review form opens with summary, category, and tags pre-filled by AI; all remain editable before Save.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: pre-fill add form with AI suggestions"
```

---

## PHASE 3 — PWA Share Target and bookmarklet

### Task 18: PWA manifest with Share Target

**Files:**
- Create: `public/manifest.json`
- Create: `public/icon-192.png`, `public/icon-512.png` (placeholder square PNGs)
- Modify: `src/app/layout.tsx` (manifest link + theme meta)

- [ ] **Step 1: Create `public/manifest.json`**

```json
{
  "name": "Reel Vault",
  "short_name": "ReelVault",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#ffffff",
  "theme_color": "#000000",
  "icons": [
    { "src": "/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png" }
  ],
  "share_target": {
    "action": "/add",
    "method": "GET",
    "params": { "title": "title", "text": "text", "url": "url" }
  }
}
```

- [ ] **Step 2: Generate placeholder icons**

```bash
npx --yes sharp-cli --version >/dev/null 2>&1 || true
node -e "const s=512;const b=Buffer.from('<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"'+s+'\" height=\"'+s+'\"><rect width=\"'+s+'\" height=\"'+s+'\" fill=\"black\"/><text x=\"50%\" y=\"55%\" font-size=\"260\" fill=\"white\" text-anchor=\"middle\" font-family=\"sans-serif\">RV</text></svg>');require('fs').writeFileSync('public/icon.svg',b);"
```

Then convert with an available tool, or — simplest — open `public/icon.svg` and export 192px and 512px PNGs with macOS Preview, saving as `public/icon-192.png` and `public/icon-512.png`. Placeholder icons are acceptable; visual polish is out of scope for this plan.

- [ ] **Step 3: Add the manifest link to `src/app/layout.tsx`**

Add to the exported `metadata` object:

```tsx
export const metadata = {
  title: "Reel Vault",
  manifest: "/manifest.json",
};
```

- [ ] **Step 4: Verify the manifest loads**

Run `npm run dev`, open `http://localhost:3000/manifest.json`. Expected: the JSON renders. In Chrome DevTools → Application → Manifest, "Reel Vault" appears with no errors.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add PWA manifest with Web Share Target"
```

### Task 19: Confirm the add page consumes shared params

**Files:**
- Verify only: `src/app/add/page.tsx`

- [ ] **Step 1: Confirm shared-param handling**

The Share Target posts to `/add?title=…&text=…&url=…`. `AddInner` already reads `params.get("url") ?? params.get("text")`. Confirm that when `text` contains a URL but `url` is empty (Instagram often puts the link in `text`), capture still works.

If `text` may contain extra words around the URL, update the `sharedUrl` line in `src/app/add/page.tsx`:

```tsx
const rawShared = params.get("url") ?? params.get("text") ?? "";
const urlMatch = rawShared.match(/https?:\/\/\S+/);
const sharedUrl = urlMatch ? urlMatch[0] : rawShared;
```

- [ ] **Step 2: Verify with a simulated share**

Run `npm run dev`, open `/add?text=check%20this%20https://example.com/reel`. Expected: the page extracts `https://example.com/reel` and auto-fetches.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: extract URL from shared text param"
```

### Task 20: Desktop bookmarklet page

**Files:**
- Create: `src/app/bookmarklet/page.tsx`

- [ ] **Step 1: Create `src/app/bookmarklet/page.tsx`**

```tsx
export default function BookmarkletPage() {
  const code =
    "javascript:(function(){window.open('" +
    "https://REPLACE_WITH_DEPLOYED_DOMAIN/add?url='" +
    "+encodeURIComponent(location.href),'_blank');})();";

  return (
    <main className="max-w-lg mx-auto p-4">
      <h1 className="text-xl font-bold mb-3">Desktop Bookmarklet</h1>
      <p className="text-sm mb-3">
        Drag this button to your bookmarks bar. On any reel or article page,
        click it to send the page to Reel Vault.
      </p>
      <a
        href={code}
        onClick={(e) => e.preventDefault()}
        className="inline-block bg-black text-white rounded px-3 py-2"
      >
        + Reel Vault
      </a>
      <p className="text-xs text-gray-500 mt-3">
        After deploying, replace REPLACE_WITH_DEPLOYED_DOMAIN in
        src/app/bookmarklet/page.tsx with the real domain.
      </p>
    </main>
  );
}
```

- [ ] **Step 2: Verify the page renders**

Run `npm run dev`, open `/bookmarklet`. Expected: instructions and a draggable "+ Reel Vault" button.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: add desktop bookmarklet install page"
```

---

## PHASE 4 — Bulk import from Instagram data export

### Task 21: Saved-posts parser (pure, TDD)

**Files:**
- Create: `src/lib/instagram-export.ts`
- Test: `src/lib/instagram-export.test.ts`

- [ ] **Step 1: Write the failing test in `src/lib/instagram-export.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import { parseSavedPosts } from "./instagram-export";

describe("parseSavedPosts", () => {
  it("extracts urls from the saved_posts JSON shape", () => {
    const json = {
      saved_saved_media: [
        {
          title: "creatorA",
          string_map_data: {
            "Saved on": {
              href: "https://www.instagram.com/reel/AAA/",
              timestamp: 1700000000,
            },
          },
        },
        {
          title: "creatorB",
          string_map_data: {
            "Saved on": {
              href: "https://www.instagram.com/reel/BBB/",
              timestamp: 1700000100,
            },
          },
        },
      ],
    };
    expect(parseSavedPosts(JSON.stringify(json))).toEqual([
      { url: "https://www.instagram.com/reel/AAA/", author: "creatorA" },
      { url: "https://www.instagram.com/reel/BBB/", author: "creatorB" },
    ]);
  });

  it("returns empty array on malformed input", () => {
    expect(parseSavedPosts("garbage")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/lib/instagram-export.test.ts`
Expected: FAIL — cannot find module `./instagram-export`.

- [ ] **Step 3: Implement `src/lib/instagram-export.ts`**

```typescript
export interface SavedPost {
  url: string;
  author?: string;
}

export function parseSavedPosts(rawJson: string): SavedPost[] {
  try {
    const data = JSON.parse(rawJson);
    const list = data.saved_saved_media;
    if (!Array.isArray(list)) return [];
    const out: SavedPost[] = [];
    for (const entry of list) {
      const href = entry?.string_map_data?.["Saved on"]?.href;
      if (typeof href === "string" && href.startsWith("http")) {
        out.push({
          url: href,
          author: typeof entry.title === "string" ? entry.title : undefined,
        });
      }
    }
    return out;
  } catch {
    return [];
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/lib/instagram-export.test.ts`
Expected: PASS — both tests green.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add Instagram saved-posts parser with tests"
```

### Task 22: Bulk import API route

**Files:**
- Create: `src/app/api/import/route.ts`

- [ ] **Step 1: Create `src/app/api/import/route.ts`**

```typescript
import { NextRequest, NextResponse } from "next/server";
import { parseSavedPosts } from "@/lib/instagram-export";

export async function POST(req: NextRequest) {
  const body = await req.text();
  const posts = parseSavedPosts(body);
  return NextResponse.json({ posts });
}
```

Rationale: the route parses the uploaded `saved_posts.json` text and returns the URL list; the client inserts rows via the existing Convex `add` mutation so dedup and enrichment logic is reused rather than duplicated server-side.

- [ ] **Step 2: Verify the route**

Run `npm run dev`, then POST a small saved-posts JSON file:
`curl -X POST http://localhost:3000/api/import --data-binary @sample-saved.json`
Expected: JSON `{ "posts": [ ... ] }`.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: add bulk-import API route for Instagram export"
```

### Task 23: Import page

**Files:**
- Create: `src/app/import/page.tsx`

- [ ] **Step 1: Create `src/app/import/page.tsx`**

```tsx
"use client";

import { useState } from "react";
import { useConvex } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { detectSource } from "@/lib/metadata";

export default function ImportPage() {
  const convex = useConvex();
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    setLog(["Reading file…"]);

    const text = await file.text();
    const res = await fetch("/api/import", { method: "POST", body: text });
    const { posts } = await res.json();
    setLog((l) => [...l, `Found ${posts.length} saved posts.`]);

    let added = 0;
    let skipped = 0;
    for (const p of posts as { url: string; author?: string }[]) {
      const existing = await convex.query(api.items.findByUrl, { url: p.url });
      if (existing) {
        skipped++;
        continue;
      }
      await convex.mutation(api.items.add, {
        url: p.url,
        source: detectSource(p.url),
        title: p.author ? `Saved from ${p.author}` : "Imported reel",
        author: p.author,
        category: "Imported",
        tags: [],
      });
      added++;
    }
    setLog((l) => [...l, `Imported ${added}, skipped ${skipped} duplicates.`]);
    setBusy(false);
  }

  return (
    <main className="max-w-lg mx-auto p-4">
      <h1 className="text-xl font-bold mb-3">Bulk Import</h1>
      <p className="text-sm mb-3">
        From your Instagram data export ZIP, find{" "}
        <code>your_instagram_activity/saved/saved_posts.json</code> and upload it
        here. Items land in the "Imported" category; open each to enrich it.
      </p>
      <input
        type="file"
        accept="application/json"
        onChange={handleFile}
        disabled={busy}
      />
      <ul className="mt-4 text-sm text-gray-700 list-disc pl-5">
        {log.map((line, i) => (
          <li key={i}>{line}</li>
        ))}
      </ul>
    </main>
  );
}
```

- [ ] **Step 2: Verify import end to end**

Create a small `saved_posts.json` matching the shape in Task 21's test, upload it on `/import`. Expected: log reports the count; items appear on the dashboard under "Imported"; re-uploading reports them all as skipped duplicates.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: add bulk-import page for Instagram saved posts"
```

---

## DEPLOYMENT

### Task 24: Deploy to Convex Cloud and Vercel

**Files:**
- Modify: `src/app/bookmarklet/page.tsx` (real domain)

- [ ] **Step 1: Deploy the Convex backend to production**

```bash
npx convex deploy
```

Note the production `NEXT_PUBLIC_CONVEX_URL` it prints.

- [ ] **Step 2: Deploy the frontend to Vercel**

```bash
npm install -g vercel
vercel
```

In the Vercel project settings, add environment variables: `NEXT_PUBLIC_CONVEX_URL` (production value), `ANTHROPIC_API_KEY`, `APP_PASSCODE`. Then run `vercel --prod`.

- [ ] **Step 3: Update the bookmarklet domain**

In `src/app/bookmarklet/page.tsx`, replace `REPLACE_WITH_DEPLOYED_DOMAIN` with the real Vercel domain. Commit and redeploy with `vercel --prod`.

- [ ] **Step 4: Verify on a phone**

Open the deployed URL on a phone, log in, "Add to Home Screen" to install the PWA. In Instagram, open a reel, tap Share, choose "Reel Vault". Expected: the app opens on `/add` with the URL captured and metadata fetching.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: set deployed domain in bookmarklet"
```

### Task 25: Final verification

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: all tests pass (`metadata`, `ai`, `instagram-export`).

- [ ] **Step 2: Run a production build**

Run: `npm run build`
Expected: build succeeds with no type errors.

- [ ] **Step 3: Smoke-test every capture path**

- Paste a URL on `/add` → saves, appears on dashboard.
- Bookmarklet on desktop → opens `/add` pre-filled.
- Share Target on phone → opens `/add` pre-filled.
- Bulk import a `saved_posts.json` → items appear under "Imported".
- Search and category filter on the dashboard return correct results.

- [ ] **Step 4: Commit any fixes**

```bash
git add -A
git commit -m "chore: final verification fixes"
```

---

## Self-Review Notes

- **Spec coverage:** Ingest (paste/bookmarklet/Share Target) — Tasks 12, 18-20. Metadata fetch — Tasks 6-7. AI enrich + review screen — Tasks 15-17. Convex store — Tasks 3-4. Dashboard grid/filter/search — Tasks 9-11. Item detail + notes — Task 13. Passcode auth — Task 8. Duplicate detection — Task 14. DYI bulk import (P4) — Tasks 21-23. Deployment — Task 24. All spec sections mapped.
- **Error handling:** metadata failure falls back to an editable form (Task 7); AI failure returns empty defaults (Task 16); duplicate URLs redirect to the existing item (Task 14).
- **Type consistency:** `Metadata`, `Source`, `ReviewDraft`, `Enrichment`, `SavedPost` are each defined once and reused; Convex `add`/`update`/`findByUrl` signatures match every call site.
