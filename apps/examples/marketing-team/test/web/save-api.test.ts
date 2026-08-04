import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { createContentTools } from '../../agent/lib/content/tools.js';
import { app } from '../../server/index.js';
import { resolveDefaultWorkspaceId } from '../../server/runtime.js';
import { markdownToTiptap } from '../../db/content-format.js';
import { contentPieces, contentRevisions } from '../../db/schema.js';
import { connectDb, makeCtx, suffix } from '../tools/helpers.js';

/**
 * These exercise `PUT /api/content/:id` through the real Hono app (`app.request(...)`, same
 * technique as `test/health.test.ts`) — the browser's actual save path, not the
 * `update_content` tool directly (that path is already covered by `test/tools/content.test.ts`).
 * They need a live Postgres, and the API always resolves to this process's one seeded
 * workspace (`resolveDefaultWorkspaceId` — see `server/runtime.ts`), so setup creates its test
 * content inside that same workspace with a unique slug rather than an isolated one.
 */
let db: NonNullable<Awaited<ReturnType<typeof connectDb>>>['db'];
let sqlClient: NonNullable<Awaited<ReturnType<typeof connectDb>>>['sqlClient'];
let reachable = false;

beforeAll(async () => {
  const conn = await connectDb();
  if (!conn) {
    console.warn('[marketing-team] Skipping web save-api tests: database unreachable.');
    return;
  }
  db = conn.db;
  sqlClient = conn.sqlClient;
  reachable = true;
});

afterAll(async () => {
  await sqlClient?.end({ timeout: 5 });
});

const dbIt = (name: string, fn: () => Promise<void>) =>
  it(name, async () => {
    if (!reachable) return;
    await fn();
  });

async function seedPiece(markdown: string) {
  const workspaceId = await resolveDefaultWorkspaceId();
  const { create_content } = createContentTools({ db, resolveScope: () => ({ workspaceId, principalId: 'p' }) });
  const s = suffix();
  const { id } = (await create_content.execute(
    { kind: 'blog', title: `Save API test ${s}`, slug: `save-api-test-${s}`, markdown },
    makeCtx({ currentAgent: 'content-marketer' }),
  )) as { id: string };
  return { id, workspaceId };
}

describe('PUT /api/content/:id', () => {
  dbIt('writes body_json and body_markdown together and appends exactly one revision', async () => {
    const { id } = await seedPiece('# Original\n\nOriginal body.');
    const beforeRevisions = await db
      .select()
      .from(contentRevisions)
      .where(eq(contentRevisions.contentPieceId, id));
    expect(beforeRevisions).toHaveLength(1); // the create_content revision

    const newJson = markdownToTiptap('# Original\n\nEdited from the browser.');
    const response = await app.request(`/api/content/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ json: newJson }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { changed: boolean };
    expect(body.changed).toBe(true);

    const [piece] = await db.select().from(contentPieces).where(eq(contentPieces.id, id));
    expect(piece!.bodyMarkdown).toBe('# Original\n\nEdited from the browser.');
    expect(piece!.bodyJson).toEqual(markdownToTiptap(piece!.bodyMarkdown));

    const afterRevisions = await db
      .select()
      .from(contentRevisions)
      .where(eq(contentRevisions.contentPieceId, id));
    expect(afterRevisions).toHaveLength(2);
    expect(afterRevisions.some((r) => r.bodyMarkdown === '# Original\n\nEdited from the browser.')).toBe(true);
  });

  dbIt('a save whose markdown round-trips unchanged does not append a revision', async () => {
    const { id } = await seedPiece('# Stable\n\nNothing about this changes.');
    const [piece] = await db.select().from(contentPieces).where(eq(contentPieces.id, id));

    // Same JSON the row already has — a no-op open-then-save, the debounce-on-every-keystroke
    // case this route is designed to absorb.
    const response = await app.request(`/api/content/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ json: piece!.bodyJson }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { changed: boolean };
    expect(body.changed).toBe(false);

    const revisions = await db.select().from(contentRevisions).where(eq(contentRevisions.contentPieceId, id));
    expect(revisions).toHaveLength(1); // only the original create_content revision
  });

  dbIt('404s for a content id in no workspace', async () => {
    const response = await app.request('/api/content/00000000-0000-0000-0000-000000000000', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ json: markdownToTiptap('# x') }),
    });
    expect(response.status).toBe(404);
  });
});

/**
 * SABOTAGE (workmanship rule 6), performed and observed, not asserted:
 *
 *   In `server/api.ts`, the `PUT /content/:id` handler (the content route, not the
 *   brand-context one — both call `tiptapToMarkdown(body.json as TiptapDocument)`, so the edit
 *   targeted the first occurrence specifically), changed
 *     `const markdown = tiptapToMarkdown(body.json as TiptapDocument);`
 *   to
 *     `const markdown = tiptapToMarkdown(body.json as TiptapDocument) + ' SABOTAGE';`
 *   Confirmed with `grep -n SABOTAGE server/api.ts` that exactly that one line changed.
 *
 *   Result: `bun test test/web/save-api.test.ts` went from 3 pass to 1 pass / 2 fail:
 *     - "writes body_json and body_markdown together…" failed at
 *       `expect(piece!.bodyMarkdown).toBe('# Original\n\nEdited from the browser.')`
 *       (this file, line 74) — diff showed the actual value carrying the appended
 *       " SABOTAGE" suffix, naming the corrupted write path directly.
 *     - "a save whose markdown round-trips unchanged does not append a revision" also failed,
 *       at `expect(body.changed).toBe(false)` (line 98) — since every save now differs from
 *       the stored value by the suffix, the unchanged-save guard could no longer trigger
 *       either, which is the correct knock-on effect of the same corrupted line.
 *
 *   Reverted the line, re-ran the suite: 3 pass / 0 fail again.
 */
