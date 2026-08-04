import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';

/**
 * The database handle, connected lazily on first use.
 *
 * This module used to read `DATABASE_URL` and throw at import time. That made every module
 * downstream of it un-importable without a database — including `server/index.ts`, whose
 * `/health` route deliberately touches no data, and its smoke test, which was written
 * specifically to prove the shell works before any schema existed.
 *
 * Throwing at import is the wrong shape for a connection: it turns a runtime requirement
 * into a load-time one, so a test that never queries still pays for the environment. The
 * error still fires — just at the first actual query, where it names a real cause.
 */
let cached: ReturnType<typeof drizzle> | undefined;

function connect(): ReturnType<typeof drizzle> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL is not set. Start Postgres with `docker compose up -d --wait` and export ' +
        'DATABASE_URL=postgres://marketing:marketing@localhost:5433/marketing',
    );
  }
  cached ??= drizzle(postgres(connectionString));
  return cached;
}

/**
 * Proxies every property access through to a lazily-created client, so `db.select(...)`
 * reads exactly as before at the call sites while the connection is deferred to first use.
 */
export const db: ReturnType<typeof drizzle> = new Proxy({} as ReturnType<typeof drizzle>, {
  get(_target, property, receiver) {
    return Reflect.get(connect() as object, property, receiver);
  },
  has(_target, property) {
    return Reflect.has(connect() as object, property);
  },
});
