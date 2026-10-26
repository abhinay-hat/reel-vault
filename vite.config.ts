import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { getRequestListener } from "@hono/node-server";
import path from "node:path";

const src = path.resolve(import.meta.dirname, "src");

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
      host: process.env.HOST || "127.0.0.1",
      strictPort: true,
    },
    preview: { port: 3210, host: process.env.HOST || "127.0.0.1" },
    // node:sqlite is loaded at runtime via process.getBuiltinModule; keep it out of bundling.
    ssr: { external: ["node:sqlite"] },
    build: { outDir: "dist" },
  };
});
