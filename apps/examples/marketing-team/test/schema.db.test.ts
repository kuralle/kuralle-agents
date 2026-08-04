import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { contentPieces, workspaces } from '../db/schema.js';

/**
 * These need a live Postgres. They skip cleanly without one rather than failing — a missing
 * container is an environment fact, not a defect — but they must be RUN against a real
 * database before this task is called done. A suite that only ever skips proves nothing.
 */
const DB_URL = process.env.DATABASE_URL ?? 'postgres://marketing:marketing@localhost:5433/marketing';

let sqlClient: ReturnType<typeof postgres> | undefined;
let db: ReturnType<typeof drizzle> | undefined;
let reachable = false;

beforeAll(async () => {
  try {
    sqlClient = postgres(DB_URL, { max: 1, connect_timeout: 5, onnotice: () => {} });
    await sqlClient`select 1`;
    db = drizzle(sqlClient);
    reachable = true;
  } catch {
    console.warn(`[marketing-team] Skipping DB tests: ${DB_URL} unreachable.`);
  }
});

afterAll(async () => {
  await sqlClient?.end({ timeout: 5 });
});

const dbIt = (name: string, fn: () => Promise<void>) =>
  it(name, async () => {
    if (!reachable) return;
    await fn();
  });

describe('schema, against a live database', () => {
  /**
   * The property every agent tool depends on. Two workspaces, the SAME slug in each: a query
   * scoped to A must never see B's row. A suite with a single tenant has nothing to leak to,
   * so this is asserted with two.
   */
  dbIt('isolates content by workspace, even on a colliding slug', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const [a] = await db!.insert(workspaces).values({ name: `iso-a-${suffix}` }).returning();
    const [b] = await db!.insert(workspaces).values({ name: `iso-b-${suffix}` }).returning();

    const slug = `shared-slug-${suffix}`;
    await db!.insert(contentPieces).values({
      workspaceId: a!.id, kind: 'blog', title: 'A piece', slug,
      bodyJson: {}, bodyMarkdown: 'A body',
    });
    await db!.insert(contentPieces).values({
      workspaceId: b!.id, kind: 'blog', title: 'B piece', slug,
      bodyJson: {}, bodyMarkdown: 'B body',
    });

    const seenByA = await db!.select().from(contentPieces)
      .where(and(eq(contentPieces.workspaceId, a!.id), eq(contentPieces.slug, slug)));

    expect(seenByA).toHaveLength(1);
    expect(seenByA[0]!.title).toBe('A piece');
    expect(seenByA.some((r) => r.workspaceId === b!.id)).toBe(false);
  });

  /** The same slug twice in ONE workspace must be refused — uniqueness is per workspace. */
  dbIt('refuses a duplicate slug within a single workspace', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const [w] = await db!.insert(workspaces).values({ name: `dup-${suffix}` }).returning();
    const slug = `dupe-${suffix}`;
    const row = {
      workspaceId: w!.id, kind: 'blog' as const, title: 'first', slug,
      bodyJson: {}, bodyMarkdown: 'x',
    };
    await db!.insert(contentPieces).values(row);
    // Its own connection: a rejected statement leaves the shared one unusable for later
    // assertions, which surfaces as a hang rather than a failure.
    const raw = postgres(DB_URL, { max: 1, connect_timeout: 5, onnotice: () => {} });
    let rejected = false;
    try {
      await drizzle(raw).insert(contentPieces).values({ ...row, title: 'second' });
    } catch {
      rejected = true;
    } finally {
      await raw.end({ timeout: 5 });
    }
    expect(rejected).toBe(true);
  });

  /** A typo in a status is a bug the database should refuse, not store. */
  dbIt('rejects a status outside the enum', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const [w] = await db!.insert(workspaces).values({ name: `enum-${suffix}` }).returning();
    // Its own connection: a rejected statement leaves the shared one unusable for the
    // remaining assertions, which reads as a hang rather than a failure.
    const probe = postgres(DB_URL, { max: 1, connect_timeout: 5, onnotice: () => {} });
    let rejected = false;
    try {
      await probe`insert into content_pieces (workspace_id, kind, title, slug, body_json, body_markdown, status)
                  values (${w!.id}, 'blog', 't', ${`enum-${suffix}`}, '{}'::jsonb, 'b', 'not-a-status')`;
    } catch {
      rejected = true;
    } finally {
      await probe.end({ timeout: 5 });
    }
    expect(rejected).toBe(true);
  });

  /** Same as the status enum: a typo in kind must not be stored either. */
  dbIt('rejects a kind outside the enum', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const [w] = await db!.insert(workspaces).values({ name: `kind-enum-${suffix}` }).returning();
    const probe = postgres(DB_URL, { max: 1, connect_timeout: 5, onnotice: () => {} });
    let rejected = false;
    try {
      await probe`insert into content_pieces (workspace_id, kind, title, slug, body_json, body_markdown, status)
                  values (${w!.id}, 'not-a-real-kind', 't', ${`kind-enum-${suffix}`}, '{}'::jsonb, 'b', 'draft')`;
    } catch {
      rejected = true;
    } finally {
      await probe.end({ timeout: 5 });
    }
    expect(rejected).toBe(true);
  });

  /**
   * A piece a human wrote has no authoring agent. If this column ever becomes NOT NULL again
   * the editor has to invent an agent name, which corrupts the audit trail it exists for.
   */
  dbIt('accepts a content piece with no authoring agent (human-written)', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const [w] = await db!.insert(workspaces).values({ name: `human-${suffix}` }).returning();
    const [row] = await db!.insert(contentPieces).values({
      workspaceId: w!.id, kind: 'blog', title: 'Written by a person', slug: `human-${suffix}`,
      bodyJson: {}, bodyMarkdown: 'A person wrote this.',
    }).returning();
    expect(row!.authoredByAgent).toBeNull();
  });

  dbIt('indexes workspace_id on every tenant-scoped table', async () => {
    const tables = [
      'brand_context', 'content_pieces', 'artifacts', 'assets',
      'user_preferences', 'campaign_links', 'social_posts', 'email_sends',
    ];
    for (const table of tables) {
      const rows = await sqlClient!<{ indexdef: string }[]>`
        select indexdef from pg_indexes where tablename = ${table}`;
      const hasWorkspaceIndex = rows.some((r) => r.indexdef.includes('workspace_id'));
      expect(`${table}:${hasWorkspaceIndex}`).toBe(`${table}:true`);
    }
  });
});

describe('seed', () => {
  /**
   * Re-running the seed must not duplicate or throw. A seed that is only safe on an empty
   * database is a seed nobody can run twice, which in practice means nobody runs it at all.
   */
  it('is idempotent', async () => {
    if (!reachable) return;
    const counts = async () => {
      const [row] = await sqlClient!`
        select (select count(*) from workspaces)::int as w,
               (select count(*) from brand_context)::int as b,
               (select count(*) from content_pieces)::int as c`;
      return row as { w: number; b: number; c: number };
    };
    const proc = Bun.spawnSync({
      cmd: ['bun', 'db/seed.ts'],
      cwd: `${import.meta.dir}/..`,
      env: { ...process.env, DATABASE_URL: DB_URL },
    });
    expect(proc.exitCode).toBe(0);
    const first = await counts();
    const again = Bun.spawnSync({
      cmd: ['bun', 'db/seed.ts'],
      cwd: `${import.meta.dir}/..`,
      env: { ...process.env, DATABASE_URL: DB_URL },
    });
    expect(again.exitCode).toBe(0);
    expect(await counts()).toEqual(first);
  });
});
