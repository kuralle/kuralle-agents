import { defineTool } from '@kuralle-agents/core';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { userPreferences } from '../../../db/schema.js';
import { resolveScope, type Db, type ResolveWorkspaceScope } from '../workspace-scope.js';

export interface UserPreferenceToolsDeps {
  db: Db;
  resolveScope: ResolveWorkspaceScope;
}

/** Per-principal preferences within a workspace, one row per (workspace, principal). */
export function createUserPreferenceTools(deps: UserPreferenceToolsDeps) {
  const { db, resolveScope: resolve } = deps;

  const get_user_preferences = defineTool({
    name: 'get_user_preferences',
    description: 'Read the calling principal’s standing preferences for this workspace.',
    input: z.object({}),
    execute: async (_input, ctx) => {
      const { workspaceId, principalId } = await resolveScope(resolve, ctx);
      const [row] = await db
        .select()
        .from(userPreferences)
        .where(
          and(eq(userPreferences.workspaceId, workspaceId), eq(userPreferences.principalId, principalId)),
        )
        .limit(1);
      if (!row) {
        return { found: false as const };
      }
      return { found: true as const, preferences: row.preferences };
    },
  });

  const save_user_preferences = defineTool({
    name: 'save_user_preferences',
    description: 'Replace the calling principal’s standing preferences for this workspace.',
    input: z.object({ preferences: z.record(z.string(), z.unknown()) }),
    execute: async ({ preferences }, ctx) => {
      const { workspaceId, principalId } = await resolveScope(resolve, ctx);
      const [saved] = await db
        .insert(userPreferences)
        .values({ workspaceId, principalId, preferences })
        .onConflictDoUpdate({
          target: [userPreferences.workspaceId, userPreferences.principalId],
          set: { preferences, updatedAt: new Date() },
        })
        .returning();
      if (!saved) {
        throw new Error('save_user_preferences: upsert returned no row');
      }
      return { id: saved.id };
    },
  });

  const clear_user_preferences = defineTool({
    name: 'clear_user_preferences',
    description: 'Permanently delete the calling principal’s standing preferences for this workspace.',
    input: z.object({}),
    needsApproval: true,
    execute: async (_input, ctx) => {
      const { workspaceId, principalId } = await resolveScope(resolve, ctx);
      const deleted = await db
        .delete(userPreferences)
        .where(
          and(eq(userPreferences.workspaceId, workspaceId), eq(userPreferences.principalId, principalId)),
        )
        .returning({ id: userPreferences.id });
      return { cleared: deleted.length > 0 };
    },
  });

  return { get_user_preferences, save_user_preferences, clear_user_preferences };
}
