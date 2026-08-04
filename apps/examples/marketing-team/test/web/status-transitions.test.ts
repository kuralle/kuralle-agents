import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { inArray, like } from 'drizzle-orm';
import { createContentTools } from '../../agent/lib/content/tools.js';
import { app } from '../../server/index.js';
import { resolveDefaultWorkspaceId } from '../../server/runtime.js';
import { contentPieces, contentRevisions } from '../../db/schema.js';
import { connectDb, makeCtx, suffix } from '../tools/helpers.js';

/**
 * `POST /api/content/:id/status` only allows the next step in `draft -> in-review -> approved
 * -> published` (see the `FORWARD_TRANSITIONS` table and its comment in `server/api.ts`) —
 * everything else (backward, sideways, skipping a step, or an unknown status string) is
 * rejected with 400.
 */
let db: NonNullable<Awaited<ReturnType<typeof connectDb>>>['db'];
let sqlClient: NonNullable<Awaited<ReturnType<typeof connectDb>>>['sqlClient'];
let reachable = false;

beforeAll(async () => {
  const conn = await connectDb();
  if (!conn) {
    console.warn('[marketing-team] Skipping status-transition tests: database unreachable.');
    return;
  }
  db = conn.db;
  sqlClient = conn.sqlClient;
  reachable = true;
});

/**
 * These drive the REST routes, which resolve the app's DEFAULT workspace — the same one the demo
 * uses. Without this the Content library fills up with "Save API test …" and "Status test …"
 * rows that never go away, one set per run, and the example looks broken to anyone who opens it.
 * The rows cannot simply go in a throwaway workspace: the route under test is the one that picks
 * the default, so the test has to write there and tidy up after itself.
 */
const CLEANUP_PREFIX = 'status-test-';

afterAll(async () => {
  if (reachable) {
    const doomed = await db
      .select({ id: contentPieces.id })
      .from(contentPieces)
      .where(like(contentPieces.slug, `${CLEANUP_PREFIX}%`));
    const ids = doomed.map((row) => row.id);
    if (ids.length > 0) {
      // Revisions first — they reference the piece.
      await db.delete(contentRevisions).where(inArray(contentRevisions.contentPieceId, ids));
      await db.delete(contentPieces).where(inArray(contentPieces.id, ids));
    }
  }
  await sqlClient?.end({ timeout: 5 });
});

const dbIt = (name: string, fn: () => Promise<void>) =>
  it(name, async () => {
    if (!reachable) return;
    await fn();
  });

async function seedPiece() {
  const workspaceId = await resolveDefaultWorkspaceId();
  const { create_content } = createContentTools({ db, resolveScope: () => ({ workspaceId, principalId: 'p' }) });
  const s = suffix();
  const { id } = (await create_content.execute(
    { kind: 'blog', title: `Status test ${s}`, slug: `status-test-${s}`, markdown: '# x' },
    makeCtx(),
  )) as { id: string };
  return id;
}

function postStatus(id: string, status: string) {
  return app.request(`/api/content/${id}/status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  });
}

describe('POST /api/content/:id/status', () => {
  dbIt('moves draft -> in-review -> approved -> published, one step at a time', async () => {
    const id = await seedPiece();

    const toReview = await postStatus(id, 'in-review');
    expect(toReview.status).toBe(200);
    expect(((await toReview.json()) as { status: string }).status).toBe('in-review');

    const toApproved = await postStatus(id, 'approved');
    expect(toApproved.status).toBe(200);
    expect(((await toApproved.json()) as { status: string }).status).toBe('approved');

    const toPublished = await postStatus(id, 'published');
    expect(toPublished.status).toBe(200);
    expect(((await toPublished.json()) as { status: string }).status).toBe('published');
  });

  dbIt('rejects skipping a step (draft -> approved)', async () => {
    const id = await seedPiece();
    const response = await postStatus(id, 'approved');
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('draft');
    expect(body.error).toContain('approved');
  });

  dbIt('rejects moving backward (in-review -> draft)', async () => {
    const id = await seedPiece();
    expect((await postStatus(id, 'in-review')).status).toBe(200);
    const response = await postStatus(id, 'draft');
    expect(response.status).toBe(400);
  });

  dbIt('rejects a status outside the enum', async () => {
    const id = await seedPiece();
    const response = await postStatus(id, 'not-a-real-status');
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('draft, in-review, approved, published');
  });

  dbIt('404s for an unknown content id', async () => {
    const response = await postStatus('00000000-0000-0000-0000-000000000000', 'in-review');
    expect(response.status).toBe(404);
  });
});
