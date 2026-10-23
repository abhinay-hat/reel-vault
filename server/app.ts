import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { NextRequest } from "@/shims/next-server";
import { PASSCODE_COOKIE, isValidAuthCookie } from "@/lib/passcode";
import * as db from "@/lib/db";
import type { VaultFilter, VaultStatus } from "@/lib/db";

type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response> | Response;
type RouteModule = Partial<Record<"GET" | "POST" | "PUT" | "PATCH" | "DELETE", Handler>>;

// Every src/app/api/**/route.ts keeps working as-is: its file path is its URL,
// with [param] segments becoming :param, exactly as under Next.
const routeModules = import.meta.glob<RouteModule>("../src/app/api/**/route.ts", { eager: true });

function toPath(file: string): string {
  return file
    .replace(/^\.\.\/src\/app/, "")
    .replace(/\/route\.ts$/, "")
    .replace(/\[([^\]]+)\]/g, ":$1");
}

// @hono/node-server passes a lightweight request object, not an undici Request,
// so `new Request(raw)` throws. Rebuild it from its parts. The body is buffered:
// re-streaming it crashed undici ("ReadableStream is already closed"), and
// bodies here are small JSON or one export ZIP. ponytail: stream if uploads get big.
async function toNextRequest(raw: Request): Promise<NextRequest> {
  const init: RequestInit = { method: raw.method, headers: raw.headers, signal: raw.signal };
  if (raw.method !== "GET" && raw.method !== "HEAD") init.body = await raw.arrayBuffer();
  return new NextRequest(raw.url, init);
}

const app = new Hono();

// The passcode gate (was src/middleware.ts). Pages are a static SPA now, so the
// gate guards the data: every /api call except login and the bearer-token share.
app.use("/api/*", async (c, next) => {
  if (!process.env.APP_PASSCODE) return next();
  const p = c.req.path;
  if (p === "/api/login" || p === "/api/share") return next();
  if (await isValidAuthCookie(getCookie(c, PASSCODE_COOKIE))) return next();
  return c.json({ error: "unauthorized" }, 401);
});

// ------------------------------------------------- page data (were server components)
const PAGE_SIZE = 60;

app.get("/api/vault", async (c) => {
  const q = c.req.query();
  const ym = (v?: string) => (v && /^\d{4}-\d{2}$/.test(v) ? v : undefined);
  const f: VaultFilter = {
    q: q.q?.trim() || undefined,
    category: q.category || undefined,
    tag: q.tag || undefined,
    kind: q.kind || undefined,
    from: ym(q.from),
    to: ym(q.to),
    status: (q.status as VaultStatus) || undefined,
    sort: q.sort === "old" ? "old" : "new",
  };
  const [facets, matched] = await Promise.all([db.vaultFacets(), db.filterItems(f)]);
  const pages = Math.max(1, Math.ceil(matched.length / PAGE_SIZE));
  const page = Math.min(Math.max(1, Number.parseInt(q.page ?? "1", 10) || 1), pages);
  return c.json({
    filter: f,
    facets,
    total: facets.total,
    matched: matched.length,
    page,
    pages,
    items: matched.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
  });
});

app.get("/api/card/:id", async (c) => {
  const id = c.req.param("id");
  const [item, position] = await Promise.all([db.getItem(id), db.getCardPosition(id)]);
  if (!item) return c.json({ error: "not_found" }, 404);
  return c.json({ item, position });
});

app.patch("/api/card/:id", async (c) => {
  const { notes } = await c.req.json<{ notes?: string }>();
  await db.updateItem(c.req.param("id"), { notes: notes ?? "" });
  return c.json({ ok: true });
});

app.delete("/api/card/:id", async (c) => {
  await db.removeItem(c.req.param("id"));
  return c.json({ ok: true });
});

app.get("/api/conversations", async (c) => c.json(await db.listConversations()));

app.get("/api/conversations/:id", async (c) => {
  const result = await db.getConversation(c.req.param("id"));
  if (!result.conversation) return c.json({ error: "not_found" }, 404);
  return c.json(result);
});

// ------------------------------------------------- the original route handlers
// Static segments before :params, deeper paths first, so /api/media/clip/:id is
// matched before /api/media/:file.
const routes = Object.entries(routeModules)
  .map(([file, mod]) => ({ path: toPath(file), mod }))
  .sort((a, b) => {
    const score = (p: string) => p.split("/").reduce((s, seg) => s + (seg.startsWith(":") ? 1 : 10), 0);
    return score(b.path) - score(a.path);
  });

for (const { path, mod } of routes) {
  for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"] as const) {
    const handler = mod[method];
    if (!handler) continue;
    app.on(method, path, async (c) =>
      handler(await toNextRequest(c.req.raw), { params: Promise.resolve(c.req.param()) }),
    );
  }
}

export default app;
