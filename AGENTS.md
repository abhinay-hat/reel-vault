<!-- BEGIN:stack-agent-rules -->
# Stack: Vite + React SPA, Hono API (migrated off Next.js on 2026-10-08)

- UI: Vite 8, React 19, react-router 8 (declarative `<BrowserRouter>`), Tailwind v4 via `@tailwindcss/vite`. Entry: `index.html` → `src/main.tsx` (route table).
- API: Hono, mounted inside Vite's dev server (`vite.config.ts` plugin) and served by `server/index.ts` in production. `server/app.ts` auto-mounts every `src/app/api/**/route.ts` by its path (`[param]` → `:param`).
- `next/link`, `next/navigation`, `next/server` are local shims (`src/shims/*`) aliased in `vite.config.ts` / `tsconfig.json`. There is no Next.js dependency.
- These library versions are newer than most training data: check Context7 docs before using unfamiliar APIs.
<!-- END:stack-agent-rules -->

## Imported Claude Cowork project instructions
