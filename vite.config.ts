import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { getRequestListener } from "@hono/node-server";
import path from "node:path";

const src = path.resolve(import.meta.dirname, "src");

/** Mirror src/lib/http-guards isLanBind (keep vite.config free of .ts imports for tsc). */
function isLanBind(host: string | undefined): boolean {
  const h = (host ?? "127.0.0.1").trim().toLowerCase();
  if (!h || h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "[::1]") {
    return false;
  }
  return true;
}

// The API runs inside Vite's dev server: one process, one port, and server code
// reloads on save. Loaded per request through ssrLoadModule (cached until a file
// changes), so @/ aliases and TypeScript work exactly as in the browser build.
function api(): Plugin {
  return {
    name: "reel-vault-api",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith("/api/")) return next();
        try {
          const { default: app } = await server.ssrLoadModule("/server/app.ts");
          await getRequestListener(app.fetch)(req, res);
        } catch (err) {
          server.ssrFixStacktrace(err as Error);
          next(err);
        }
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  // Server code reads process.env (APIFY_TOKEN, LLM_*, APP_PASSCODE …) as it did under Next.
  Object.assign(process.env, loadEnv(mode, import.meta.dirname, ""));
  const host = (process.env.HOST || "127.0.0.1").trim() || "127.0.0.1";
  // Match server/index.ts: never expose the API on a LAN bind without a passcode.
  if (isLanBind(host) && !process.env.APP_PASSCODE) {
    throw new Error(
      "Refusing to bind Vite to non-loopback HOST without APP_PASSCODE. Set APP_PASSCODE or use HOST=127.0.0.1.",
    );
  }
  return {
    plugins: [react(), tailwindcss(), api()],
    resolve: {
      alias: {
        "@": src,
        "next/link": path.join(src, "shims/next-link.tsx"),
        "next/navigation": path.join(src, "shims/next-navigation.ts"),
        "next/server": path.join(src, "shims/next-server.ts"),
      },
    },
    // Default loopback. Set HOST (and APP_PASSCODE) to expose on the LAN.
    server: {
      port: 3210,
      host,
      strictPort: true,
    },
    preview: { port: 3210, host },
    // node:sqlite is loaded at runtime via process.getBuiltinModule; keep it out of bundling.
    ssr: { external: ["node:sqlite"] },
    build: { outDir: "dist" },
  };
});
