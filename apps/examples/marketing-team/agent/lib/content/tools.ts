import { defineTool } from '@kuralle-agents/core';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { markdownToTiptap } from '../../../db/content-format.js';
import { contentKind, contentPieces, contentRevisions, contentStatus } from '../../../db/schema.js';
import { actingAgent, resolveScope, type Db, type ResolveWorkspaceScope } from '../workspace-scope.js';

export interface ContentToolsDeps {
  db: Db;
  resolveScope: ResolveWorkspaceScope;
}

const kind = z.enum(contentKind.enumValues);
const status = z.enum(contentStatus.enumValues);
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const slug = z.string().min(1).max(80).regex(SLUG, 'lowercase letters, numbers, and single hyphens only');

/**
 * The Notion replacement. Agents always pass Markdown; `body_json` (Tiptap) is derived from
 * it and both columns are written together in the same transaction, alongside an append-only
 * `content_revisions` row — never one column without the other, and never a silent edit.
 */
export function createContentTools(deps: ContentToolsDeps) {
  const { db, resolveScope: resolve } = deps;

  const create_content = defineTool({
    name: 'create_content',
    description: 'Create a new content piece from Markdown.',
    input: z.object({
      kind,
      title: z.string().min(1).max(200),
      slug,
      markdown: z.string().min(1).max(200_000),
    }),
    execute: async ({ kind: k, title, slug: s, markdown }, ctx) => {
      const { workspaceId } = await resolveScope(resolve, ctx);
      const authoredByAgent = actingAgent(ctx);
      const bodyJson = markdownToTiptap(markdown);

      return db.transaction(async (tx) => {
        const [saved] = await tx
          .insert(contentPieces)
          .values({
            workspaceId,
            kind: k,
            title,
            slug: s,
            bodyJson,
            bodyMarkdown: markdown,
            authoredByAgent,
          })
          .returning();
        if (!saved) {
          throw new Error('create_content: insert returned no row');
        }
        await tx.insert(contentRevisions).values({
          workspaceId,
          contentPieceId: saved.id,
          bodyJson,
          bodyMarkdown: markdown,
          editedByAgent: authoredByAgent,
        });
        return { id: saved.id, slug: saved.slug, status: saved.status };
      });
    },
  });

  const update_content = defineTool({
    name: 'update_content',
    description: 'Replace an existing content piece’s body from Markdown, recording the prior version.',
    input: z.object({ id: z.uuid(), markdown: z.string().min(1).max(200_000) }),
    execute: async ({ id, markdown }, ctx) => {
      const { workspaceId } = await resolveScope(resolve, ctx);
      const editedByAgent = actingAgent(ctx);
      const bodyJson = markdownToTiptap(markdown);

      return db.transaction(async (tx) => {
        const [updated] = await tx
          .update(contentPieces)
          .set({ bodyJson, bodyMarkdown: markdown, updatedAt: new Date() })
          .where(and(eq(contentPieces.id, id), eq(contentPieces.workspaceId, workspaceId)))
          .returning();
        if (!updated) {
          return { found: false as const };
        }
        await tx.insert(contentRevisions).values({
          workspaceId,
          contentPieceId: updated.id,
          bodyJson,
          bodyMarkdown: markdown,
          editedByAgent,
        });
        return { found: true as const, id: updated.id, slug: updated.slug, status: updated.status };
      });
    },
  });

  const get_content = defineTool({
    name: 'get_content',
    description: 'Read one content piece by id, including its current Markdown body.',
    input: z.object({ id: z.uuid() }),
    execute: async ({ id }, ctx) => {
      const { workspaceId } = await resolveScope(resolve, ctx);
      const [row] = await db
        .select()
        .from(contentPieces)
        .where(and(eq(contentPieces.id, id), eq(contentPieces.workspaceId, workspaceId)))
        .limit(1);
      if (!row) {
        return { found: false as const };
      }
      return {
        found: true as const,
        id: row.id,
        kind: row.kind,
        title: row.title,
        slug: row.slug,
        status: row.status,
        bodyMarkdown: row.bodyMarkdown,
        updatedAt: row.updatedAt.toISOString(),
      };
    },
  });

  const list_content = defineTool({
    name: 'list_content',
    description: 'List content pieces in the workspace, optionally filtered by kind and/or status.',
    input: z.object({ kind: kind.optional(), status: status.optional() }),
    execute: async ({ kind: k, status: st }, ctx) => {
      const { workspaceId } = await resolveScope(resolve, ctx);
      const conditions = [eq(contentPieces.workspaceId, workspaceId)];
      if (k) conditions.push(eq(contentPieces.kind, k));
      if (st) conditions.push(eq(contentPieces.status, st));
      const rows = await db
        .select()
        .from(contentPieces)
        .where(and(...conditions));
      return {
        content: rows.map((row) => ({
          id: row.id,
          kind: row.kind,
          title: row.title,
          slug: row.slug,
          status: row.status,
          updatedAt: row.updatedAt.toISOString(),
        })),
      };
    },
  });

  const set_content_status = defineTool({
    name: 'set_content_status',
    description: 'Change a content piece’s status (draft, in-review, approved, published).',
    input: z.object({ id: z.uuid(), status }),
    execute: async ({ id, status: st }, ctx) => {
      const { workspaceId } = await resolveScope(resolve, ctx);
      const [updated] = await db
        .update(contentPieces)
        .set({ status: st, updatedAt: new Date() })
        .where(and(eq(contentPieces.id, id), eq(contentPieces.workspaceId, workspaceId)))
        .returning();
      if (!updated) {
        return { found: false as const };
      }
      return { found: true as const, id: updated.id, status: updated.status };
    },
  });

  return { create_content, update_content, get_content, list_content, set_content_status };
}
