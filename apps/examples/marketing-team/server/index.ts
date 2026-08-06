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

/**
 * Bun binds this automatically when the file is run directly; importing `app` does not.
 *
 * `idleTimeout` is the load-bearing field. Bun closes a connection after 10 seconds without a
 * write by default, which is fine for JSON endpoints and wrong for this one: an agent turn
 * streams a burst of deltas, then goes quiet for a model round trip after each tool call. A
 * turn that loads two skills and reads a resource before writing anything is silently cut
 * mid-stream — no `finish` frame, no error frame, nothing the client can distinguish from a
 * slow reply. The browser just shows "Sending…" forever. Observed on the second turn of a live
 * conversation on 2026-08-04; the only trace is `[Bun.serve]: request timed out after 10
 * seconds` in the server log, and the turn itself completes fine server-side.
 *
 * 255 seconds is Bun's maximum. It is the right value here rather than a merely larger guess:
 * the timeout is protecting against dead sockets, and for a streaming agent endpoint any
 * threshold short enough to catch those is also short enough to sever live turns.
 */
export default {
  port: Number(process.env.PORT) || 3000,
  idleTimeout: 255,
  fetch: app.fetch,
};
