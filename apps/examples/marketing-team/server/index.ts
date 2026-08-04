import { Hono } from 'hono';
import { api } from './api.js';

// Run with `bun run dev:server` (Bun only): the agent factories under agent/** read their
// instructions/skills off disk with `import.meta.dir`, a Bun runtime extension that a bundler
// (webpack/Turbopack, for the Next.js app under web/) neither resolves nor polyfills. The web
// app never imports this file — it talks to it over HTTP, proxied through `web/next.config.ts`
// — so the agent runtime and the Postgres driver stay out of the Next.js build entirely, and
// `DATABASE_URL` never has to reach that process at all, let alone the browser.
export const app = new Hono();

app.get('/health', (c) => c.json({ status: 'ok' }));
app.route('/api', api);

// Bun binds this automatically when the file is run directly; importing `app` does not.
export default app;
