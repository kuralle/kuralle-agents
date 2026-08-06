import { defineTool } from '@kuralle-agents/core';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { artifacts } from '../../../db/schema.js';
import { actingAgent, resolveScope, type Db, type ResolveWorkspaceScope } from '../workspace-scope.js';

export interface ArtifactToolsDeps {
  db: Db;
  resolveScope: ResolveWorkspaceScope;
}

/**
 * Handoff payloads specialists pass to each other by id, so the payload text itself never
 * has to enter a caller's context. `save_artifact` is given to every specialist that produces
 * a handoff; `read_artifact` alone is given to the lead — the lead never gets the writer. That
 * split is a deliberate context-control decision made at the agent-wiring layer (b5), not
 * something this module enforces; this module only guarantees an artifact can never be read
 * or overwritten across a workspace boundary.
 */
export function createArtifactTools(deps: ArtifactToolsDeps) {
  const { db, resolveScope: resolve } = deps;

  const save_artifact = defineTool({
    name: 'save_artifact',
    description: 'Store a handoff payload for another specialist to read by id.',
    input: z.object({
      kind: z.string().min(1).max(64),
      payload: z.record(z.string(), z.unknown()),
    }),
    execute: async ({ kind, payload }, ctx) => {
      const { workspaceId } = await resolveScope(resolve, ctx);
      const createdByAgent = actingAgent(ctx);
      const [saved] = await db
        .insert(artifacts)
        .values({ workspaceId, kind, payload, createdByAgent })
        .returning();
      if (!saved) {
        throw new Error('save_artifact: insert returned no row');
      }
      return { id: saved.id };
    },
  });

  const read_artifact = defineTool({
    name: 'read_artifact',
    description: 'Read a previously saved handoff payload by id.',
    input: z.object({ id: z.uuid() }),
    execute: async ({ id }, ctx) => {
      const { workspaceId } = await resolveScope(resolve, ctx);
      const [row] = await db
        .select()
        .from(artifacts)
        .where(and(eq(artifacts.id, id), eq(artifacts.workspaceId, workspaceId)))
        .limit(1);
      if (!row) {
        return { found: false as const };
      }
      return {
        found: true as const,
        id: row.id,
        kind: row.kind,
        payload: row.payload,
        createdByAgent: row.createdByAgent,
      };
    },
  });

  return { save_artifact, read_artifact };
}
