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
  /**
   * YAML front matter is not body. A blog piece arrived with
   * `---\nmeta_description: …\n---` at the top; prosemirror-markdown has no front-matter
   * concept, so it parsed the delimiters as a thematic break and the fields as a heading, and
   * the editor rendered both. `body_markdown` — the column `get_content` hands back to the next
   * agent — kept the whole block too.
   *
   * The converter is not at fault: hr+heading is the correct parse of that text AS MARKDOWN.
   * The defect is that the tool accepted a DOCUMENT where it means to accept a BODY, and no
   * column exists for page metadata, so the model smuggled it through the only field it had.
   */
  dbIt('rejects YAML front matter instead of storing it as body', async () => {
    const sfx = suffix();
    const workspace = await createWorkspace(db, `content-fm-${sfx}`);
    const { create_content } = createContentTools({
      db,
      resolveScope: () => ({ workspaceId: workspace.id, principalId: 'p' }),
    });
    const markdown = [
      '---',
      'meta_description: Practical ways small teams use AI.',
      'target_query: how small teams use AI',
      '---',
      '',
      'Small marketing teams often run into the same wall.',
      '',
    ].join('\n');

    let caught: unknown;
    try {
      await create_content.execute(
        { kind: 'blog', title: 'T', slug: `fm-${sfx}`, markdown },
        makeCtx({ currentAgent: 'content-marketer' }),
      );
    } catch (error) {
      caught = error;
    }

    expect((caught as Error | undefined)?.name).toBe('RecoverableToolError');
    expect((caught as Error).message).toContain('metaDescription');

    // Nothing partial written.
    const rows = await db.select().from(contentPieces).where(eq(contentPieces.workspaceId, workspace.id));
    expect(rows).toHaveLength(0);
  });

  dbIt('rejects metadata appended as a trailer, not just front matter', async () => {
    // The shape the model reached for the moment front matter was closed off: same information,
    // moved to the bottom after a rule. Guarding only the top would have declared victory while
    // the editor still rendered "Meta description: …" as the last thing the reader sees.
    const sfx = suffix();
    const workspace = await createWorkspace(db, `content-trail-${sfx}`);
    const { create_content } = createContentTools({
      db,
      resolveScope: () => ({ workspaceId: workspace.id, principalId: 'p' }),
    });
    const markdown = [
      '# A real post',
      '',
      'Body that is genuinely the body.',
      '',
      '---',
      '',
      // Bolded, which is how the model actually wrote it once the bare-label form was closed.
      '**Meta description:** Why small teams ship faster.',
      '**Target query:** small teams ai speed',
      '',
      '**Internal links:**',
      '- [Something](#)',
      '',
    ].join('\n');

    let caught: unknown;
    try {
      await create_content.execute(
        { kind: 'blog', title: 'T', slug: `trail-${sfx}`, markdown },
        makeCtx({ currentAgent: 'content-marketer' }),
      );
    } catch (error) {
      caught = error;
    }
    expect((caught as Error | undefined)?.name).toBe('RecoverableToolError');
    expect((caught as Error).message).toContain('metaDescription');
  });

  dbIt('stores metadata passed as its own arguments, keeping the body clean', async () => {
    const sfx = suffix();
    const workspace = await createWorkspace(db, `content-meta-${sfx}`);
    const { create_content } = createContentTools({
      db,
      resolveScope: () => ({ workspaceId: workspace.id, principalId: 'p' }),
    });
    const markdown = '# A real post\n\nBody that is genuinely the body.\n';

    const { id } = (await create_content.execute(
      {
        kind: 'blog',
        title: 'T',
        slug: `meta-${sfx}`,
        markdown,
        metaDescription: 'Why small teams ship faster.',
        targetQuery: 'small teams ai speed',
      },
      makeCtx({ currentAgent: 'content-marketer' }),
    )) as { id: string };

    const [piece] = await db.select().from(contentPieces).where(eq(contentPieces.id, id));
    expect(piece!.metaDescription).toBe('Why small teams ship faster.');
    expect(piece!.targetQuery).toBe('small teams ai speed');
    expect(piece!.bodyMarkdown).toBe(markdown);
    expect(piece!.bodyMarkdown).not.toContain('Meta description');
  });

  dbIt('still accepts a body that legitimately opens with a thematic break', async () => {
    const sfx = suffix();
    const workspace = await createWorkspace(db, `content-hr-${sfx}`);
    const { create_content } = createContentTools({
      db,
      resolveScope: () => ({ workspaceId: workspace.id, principalId: 'p' }),
    });
    // A `---` followed by prose is an ordinary thematic break, not front matter. Rejecting on
    // "starts with ---" alone would break real documents, so the guard must look at what sits
    // between the delimiters.
    const markdown = '---\n\nAn intro after a divider.\n';

    const { id } = (await create_content.execute(
      { kind: 'blog', title: 'T', slug: `hr-${sfx}`, markdown },
      makeCtx({ currentAgent: 'content-marketer' }),
    )) as { id: string };

    const [piece] = await db.select().from(contentPieces).where(eq(contentPieces.id, id));
    expect(piece!.bodyMarkdown).toBe(markdown);
  });

  dbIt('rejects a duplicate slug with an actionable error, not a raw SQL failure', async () => {
    const sfx = suffix();
    const workspace = await createWorkspace(db, `content-dupe-${sfx}`);
    const { create_content } = createContentTools({
      db,
      resolveScope: () => ({ workspaceId: workspace.id, principalId: 'p' }),
    });
    const taken = `taken-${sfx}`;
    const ctx = makeCtx({ currentAgent: 'content-marketer' });

    const { id } = (await create_content.execute(
      { kind: 'blog', title: 'The original', slug: taken, markdown: 'First body.' },
      ctx,
    )) as { id: string };

    // Same slug, same workspace: the `(workspace_id, slug)` unique index rejects it. What the
    // model receives back is the whole point — a raw driver error carries the full INSERT and
    // every bound parameter (including the entire document body) and says nothing about which
    // piece holds the slug, so the model cannot recover from it.
    let caught: unknown;
    try {
      await create_content.execute(
        { kind: 'blog', title: 'A second piece', slug: taken, markdown: 'Second body.' },
        ctx,
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect((caught as Error).name).toBe('RecoverableToolError');
    expect(message).toContain(taken);
    expect(message).toContain(id); // names the conflicting piece so `update_content` is reachable
    expect(message).toContain('update_content');
    expect(message).not.toContain('insert into'); // no SQL, and therefore no body dump
    expect(message).not.toContain('Second body.');

    // The failed call must not have written a partial row or an orphan revision.
    const rows = await db.select().from(contentPieces).where(eq(contentPieces.workspaceId, workspace.id));
    expect(rows).toHaveLength(1);
  });

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
