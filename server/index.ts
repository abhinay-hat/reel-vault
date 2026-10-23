import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import api from "./app";

// Production: one Node process serves the built SPA (dist/) and the API.
const root = new Hono();
root.route("/", api);
root.use("/*", serveStatic({ root: "./dist" }));
// Client-side routes (/item/:id, /chat, …) all load the SPA shell.
root.get("*", serveStatic({ path: "./dist/index.html" }));

const port = Number(process.env.PORT ?? 3210);
serve({ fetch: root.fetch, port, hostname: "0.0.0.0" }, () => {
  console.log(`Reel Vault on http://localhost:${port}`);
});
