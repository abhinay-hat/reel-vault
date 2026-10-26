import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import api from "./app";
import { isLanBind } from "../src/lib/http-guards";

// Production: one Node process serves the built SPA (dist/) and the API.
const root = new Hono();
root.route("/", api);
root.use("/*", serveStatic({ root: "./dist" }));
// Client-side routes (/item/:id, /chat, …) all load the SPA shell.
root.get("*", serveStatic({ path: "./dist/index.html" }));

const port = Number(process.env.PORT ?? 3210);
// Default to loopback. LAN bind only via explicit HOST, and then APP_PASSCODE
// is required so an open API is never reachable on the network.
const hostname = (process.env.HOST ?? "127.0.0.1").trim() || "127.0.0.1";
if (isLanBind(hostname) && !process.env.APP_PASSCODE) {
  console.error(
    "Refusing to bind to non-loopback HOST without APP_PASSCODE. Set APP_PASSCODE or use HOST=127.0.0.1.",
  );
  process.exit(1);
}

serve({ fetch: root.fetch, port, hostname }, () => {
  console.log(`Reel Vault on http://${hostname}:${port}`);
});
