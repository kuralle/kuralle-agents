import { eq } from 'drizzle-orm';
import { db } from './client.js';
import { markdownToTiptap } from './content-format.js';
import { brandContext, contentPieces, workspaces } from './schema.js';

// Idempotent: re-running must not duplicate rows or throw. The workspace is
// looked up by name (no natural key exists yet at this layer); brand context
// and content pieces upsert against the unique constraints the schema
// already carries (workspace_id, and (workspace_id, slug)).

const WORKSPACE_NAME = 'Acme Marketing';

const BRAND_CONTEXT_MARKDOWN = `# Acme brand context

## Positioning

Acme helps small marketing teams ship consistent content without a full-time ops hire.

## Voice

Direct, concrete, no filler adjectives.`;

const CONTENT_PIECES = [
  {
    slug: 'welcome-to-acme',
    title: 'Welcome to Acme',
    kind: 'blog' as const,
    markdown: `# Welcome to Acme

Acme is the fastest way for a small team to run marketing like a big one.`,
  },
  {
    slug: 'q1-product-newsletter',
    title: 'Q1 product newsletter',
    kind: 'newsletter' as const,
    markdown: `# Q1 product newsletter

Here is what shipped this quarter, and what is next.`,
  },
];

async function seed() {
  let [workspace] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.name, WORKSPACE_NAME))
    .limit(1);

  if (!workspace) {
    [workspace] = await db.insert(workspaces).values({ name: WORKSPACE_NAME }).returning();
  }
  if (!workspace) {
    throw new Error('seed: failed to create or find workspace');
  }

  await db
    .insert(brandContext)
    .values({
      workspaceId: workspace.id,
      bodyMarkdown: BRAND_CONTEXT_MARKDOWN,
      bodyJson: markdownToTiptap(BRAND_CONTEXT_MARKDOWN),
    })
    .onConflictDoUpdate({
      target: brandContext.workspaceId,
      set: {
        bodyMarkdown: BRAND_CONTEXT_MARKDOWN,
        bodyJson: markdownToTiptap(BRAND_CONTEXT_MARKDOWN),
        updatedAt: new Date(),
      },
    });

  for (const piece of CONTENT_PIECES) {
    await db
      .insert(contentPieces)
      .values({
        workspaceId: workspace.id,
        kind: piece.kind,
        title: piece.title,
        slug: piece.slug,
        status: 'draft',
        bodyMarkdown: piece.markdown,
        bodyJson: markdownToTiptap(piece.markdown),
        authoredByAgent: 'seed-script',
      })
      .onConflictDoUpdate({
        target: [contentPieces.workspaceId, contentPieces.slug],
        set: {
          title: piece.title,
          bodyMarkdown: piece.markdown,
          bodyJson: markdownToTiptap(piece.markdown),
          updatedAt: new Date(),
        },
      });
  }

  const [readBackWorkspace] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, workspace.id));
  const [readBackBrandContext] = await db
    .select()
    .from(brandContext)
    .where(eq(brandContext.workspaceId, workspace.id));
  const readBackContentPieces = await db
    .select()
    .from(contentPieces)
    .where(eq(contentPieces.workspaceId, workspace.id));

  console.log(
    JSON.stringify(
      {
        workspace: readBackWorkspace,
        brandContext: readBackBrandContext,
        contentPieces: readBackContentPieces,
      },
      null,
      2,
    ),
  );
}

seed()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
