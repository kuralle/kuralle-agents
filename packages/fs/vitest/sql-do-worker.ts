// Minimal Durable Object with SQLite storage, so the workers-vitest can run
// SqlFileSystem over a REAL workerd `ctx.storage.sql` (not bun:sqlite). The DO
// itself is empty — the test drives it via `runInDurableObject`.
import { DurableObject } from 'cloudflare:workers';

export class SqlFsDO extends DurableObject {}

export default {
  fetch() {
    return new Response('ok');
  },
};
