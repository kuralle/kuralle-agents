import { defineTool } from '@kuralle-agents/core';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { markdownToTiptap } from '../../../db/content-format.js';
import { brandContext, brandContextRevisions } from '../../../db/schema.js';
import { actingAgent, resolveScope, type Db, type ResolveWorkspaceScope } from '../workspace-scope.js';

export interface BrandContextToolsDeps {
  db: Db;
  resolveScope: ResolveWorkspaceScope;
}

/**
 * The shared positioning document the product marketer owns and the other specialists read
 * at the start of every task. One row per workspace; every overwrite is recorded so a change
 * to shared positioning is auditable the same way a content edit is.
 */
export function createBrandContextTools(deps: BrandContextToolsDeps) {
  const { db, resolveScope: resolve } = deps;

  const get_brand_context = defineTool({
    name: 'get_brand_context',
    description: 'Read the workspace’s shared brand-context document.',
    input: z.object({}),
    execute: async (_input, ctx) => {
      const { workspaceId } = await resolveScope(resolve, ctx);
      const [row] = await db
        .select()
        .from(brandContext)
        .where(eq(brandContext.workspaceId, workspaceId))
        .limit(1);
      if (!row) {
        return { found: false as const };
      }
      return {
        found: true as const,
        bodyMarkdown: row.bodyMarkdown,
        updatedAt: row.updatedAt.toISOString(),
      };
    },
  });

  const save_brand_context = defineTool({
    name: 'save_brand_context',
    description:
      'Overwrite the workspace’s brand-context document from Markdown, recording the prior version in its revision history.',
    input: z.object({ markdown: z.string().min(1).max(100_000) }),
    execute: async ({ markdown }, ctx) => {
      const { workspaceId } = await resolveScope(resolve, ctx);
      const editedByAgent = actingAgent(ctx);
      const bodyJson = markdownToTiptap(markdown);

      return db.transaction(async (tx) => {
        const [saved] = await tx
          .insert(brandContext)
          .values({ workspaceId, bodyMarkdown: markdown, bodyJson })
          .onConflictDoUpdate({
            target: brandContext.workspaceId,
            set: { bodyMarkdown: markdown, bodyJson, updatedAt: new Date() },
          })
          .returning();
        if (!saved) {
          throw new Error('save_brand_context: upsert returned no row');
        }
        await tx.insert(brandContextRevisions).values({
          workspaceId,
          brandContextId: saved.id,
          bodyJson,
          bodyMarkdown: markdown,
          editedByAgent,
        });
        return { id: saved.id, updatedAt: saved.updatedAt.toISOString() };
      });
    },
  });

  return { get_brand_context, save_brand_context };
}
