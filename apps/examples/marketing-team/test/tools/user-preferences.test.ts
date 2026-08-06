import { needsApprovalPolicy } from '@kuralle-agents/core';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { createUserPreferenceTools } from '../../agent/lib/user-preferences/tools.js';
import type { Db } from '../../agent/lib/workspace-scope.js';
import { userPreferences } from '../../db/schema.js';
import { connectDb, createWorkspace, makeCtx, suffix } from './helpers.js';

// These two tests only inspect tool metadata / drive the policy layer; `db` is never
// dereferenced. Still typed as `Db` (not `any`) so a real signature change is caught.
const unusedDb = {} as unknown as Db;

let db: NonNullable<Awaited<ReturnType<typeof connectDb>>>['db'];
let sqlClient: NonNullable<Awaited<ReturnType<typeof connectDb>>>['sqlClient'];
let reachable = false;

beforeAll(async () => {
  const conn = await connectDb();
  if (!conn) {
    console.warn('[marketing-team] Skipping user-preferences tests: database unreachable.');
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

describe('clear_user_preferences approval gate', () => {
  it('is denied without approval — needsApproval sugars to a policy "ask" decision', async () => {
    const { clear_user_preferences } = createUserPreferenceTools({
      db: unusedDb, // never touched: this only exercises the policy layer
      resolveScope: () => ({ workspaceId: 'unused', principalId: 'unused' }),
    });
    expect(clear_user_preferences.needsApproval).toBe(true);

    const decision = await needsApprovalPolicy.decide({
      toolName: 'clear_user_preferences',
      args: {},
      def: clear_user_preferences,
    });
    expect(decision.kind).toBe('ask');
  });

  it('every OTHER user-preferences tool runs without asking — the gate is specific to clear', () => {
    const { get_user_preferences, save_user_preferences } = createUserPreferenceTools({
      db: unusedDb,
      resolveScope: () => ({ workspaceId: 'unused', principalId: 'unused' }),
    });
    expect(get_user_preferences.needsApproval).not.toBe(true);
    expect(save_user_preferences.needsApproval).not.toBe(true);
  });

  dbIt('succeeds once the policy has approved it — the tool itself just clears the row', async () => {
    const s = suffix();
    const workspace = await createWorkspace(db, `prefs-clear-${s}`);
    const { save_user_preferences, clear_user_preferences } = createUserPreferenceTools({
      db,
      resolveScope: () => ({ workspaceId: workspace.id, principalId: 'principal-1' }),
    });
    await save_user_preferences.execute({ preferences: { tone: 'direct' } }, makeCtx());

    // The tool has no notion of "approved" — that gate lives entirely in the policy layer
    // tested above. Calling `execute` here simulates the executor invoking it AFTER a human
    // has approved the paused request.
    const result = (await clear_user_preferences.execute({}, makeCtx())) as { cleared: boolean };
    expect(result.cleared).toBe(true);

    const rows = await db
      .select()
      .from(userPreferences)
      .where(eq(userPreferences.workspaceId, workspace.id));
    expect(rows).toHaveLength(0);
  });
});
