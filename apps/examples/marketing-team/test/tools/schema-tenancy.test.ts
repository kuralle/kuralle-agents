import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { createMarketingTools } from '../../agent/lib/index.js';
import type { Db } from '../../agent/lib/workspace-scope.js';

// This test only inspects zod input shapes; no tool is ever executed, so `db` is never
// dereferenced. Still typed as `Db` (not `any`) so a real signature change here is caught.
const unusedDb = {} as unknown as Db;

/**
 * No tool input schema may declare a workspace/tenant field — that is the classic cross-tenant
 * seam (a caller-supplied id belonging to someone else sails straight through validation).
 * Every workspace id in this codebase comes from `resolveScope(ctx)`, never from model input.
 *
 * The tool list is derived from calling the real `createMarketingTools` factory and walking
 * its RETURNED tools, not a hand-written array of names — a hand-maintained list cannot
 * notice a tool someone adds later and forgets to enumerate here.
 */
const TENANT_FIELD = /workspace|tenant/i;

function buildTools() {
  return createMarketingTools({
    db: unusedDb,
    resolveScope: () => ({ workspaceId: 'unused', principalId: 'unused' }),
    storageRoot: '/tmp/unused',
    surfaces: ['blog'],
  });
}

describe('no tool input schema declares a workspace/tenant field', () => {
  const tools = buildTools();
  const names = Object.keys(tools);

  it('discovered more than a token number of tools (the walk is real, not vacuous)', () => {
    // 19 today: 2 brand-context + 2 artifacts + 5 assets + 5 content + 1 lint + 1 tracking + 3
    // user-preferences. This assertion exists so a future refactor that empties the tool set
    // by accident fails loudly here instead of the loop below silently checking nothing.
    expect(names.length).toBeGreaterThanOrEqual(19);
  });

  it.each(Object.entries(buildTools()))('%s has no workspace/tenant field in its input schema', (name, tool) => {
    const schema = tool.input;
    if (!schema) return; // no input at all (none of these tools omit input, but nothing to walk if one did)
    if (!(schema instanceof z.ZodObject)) {
      throw new Error(`${name}: expected a z.object() input schema, got something else`);
    }
    const fields = Object.keys(schema.shape);
    const offender = fields.find((field) => TENANT_FIELD.test(field));
    expect(offender, `${name} declares a tenant-shaped input field: ${offender}`).toBeUndefined();
  });
});
