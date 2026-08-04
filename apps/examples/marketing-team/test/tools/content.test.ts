import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { createContentTools } from '../../agent/lib/content/tools.js';
import { markdownToTiptap } from '../../db/content-format.js';
import { contentPieces, contentRevisions } from '../../db/schema.js';
import { connectDb, createWorkspace, makeCtx, suffix } from './helpers.js';

let db: NonNullable<Awaited<ReturnType<typeof connectDb>>>['db'];
let sqlClient: NonNullable<Awaited<ReturnType<typeof connectDb>>>['sqlClient'];
let reachable = false;

beforeAll(async () => {
  const conn = await connectDb();
  if (!conn) {
    console.warn('[marketing-team] Skipping content tests: database unreachable.');
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

describe('create_content', () => {
  dbIt('writes body_json and body_markdown together, and a revision row, in one call', async () => {
    const s = suffix();
    const workspace = await createWorkspace(db, `content-create-${s}`);
    const { create_content } = createContentTools({
      db,
      resolveScope: () => ({ workspaceId: workspace.id, principalId: 'p' }),
    });
    const markdown = '# Title\n\nA paragraph with **bold** text.';

    const { id } = (await create_content.execute(
      { kind: 'blog', title: 'Title', slug: `slug-${s}`, markdown },
      makeCtx({ currentAgent: 'content-marketer' }),
    )) as { id: string };

    const [piece] = await db.select().from(contentPieces).where(eq(contentPieces.id, id));
    expect(piece).toBeDefined();
    expect(piece!.bodyMarkdown).toBe(markdown);
    expect(piece!.bodyJson).toEqual(markdownToTiptap(markdown));
    expect(piece!.authoredByAgent).toBe('content-marketer');

    const revisions = await db.select().from(contentRevisions).where(eq(contentRevisions.contentPieceId, id));
    expect(revisions).toHaveLength(1);
    expect(revisions[0]!.bodyMarkdown).toBe(markdown);
    expect(revisions[0]!.bodyJson).toEqual(markdownToTiptap(markdown));
    expect(revisions[0]!.editedByAgent).toBe('content-marketer');
  });

  dbIt('update_content appends a second revision without discarding the first', async () => {
    const s = suffix();
    const workspace = await createWorkspace(db, `content-update-${s}`);
    const { create_content, update_content } = createContentTools({
      db,
      resolveScope: () => ({ workspaceId: workspace.id, principalId: 'p' }),
    });
    const { id } = (await create_content.execute(
      { kind: 'blog', title: 'Title', slug: `slug-${s}`, markdown: 'v1' },
      makeCtx(),
    )) as { id: string };

    await update_content.execute({ id, markdown: 'v2' }, makeCtx());

    const [piece] = await db.select().from(contentPieces).where(eq(contentPieces.id, id));
    expect(piece!.bodyMarkdown).toBe('v2');
    expect(piece!.bodyJson).toEqual(markdownToTiptap('v2'));

    const revisions = await db.select().from(contentRevisions).where(eq(contentRevisions.contentPieceId, id));
    expect(revisions).toHaveLength(2);
    expect(revisions.map((r) => r.bodyMarkdown).sort()).toEqual(['v1', 'v2']);
  });
});
