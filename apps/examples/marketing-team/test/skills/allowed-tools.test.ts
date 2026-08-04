import { describe, expect, it } from 'bun:test';
import { createMarketingTools } from '../../agent/lib/index.js';
import type { Db } from '../../agent/lib/workspace-scope.js';
import { packageAllSkills } from './helpers.js';

// Only tool *names* are inspected below; no tool is ever executed, so `db` is never
// dereferenced. Typed as `Db` (not `any`), matching the convention in
// `test/tools/schema-tenancy.test.ts`, so a real signature change is still caught.
const unusedDb = {} as unknown as Db;

/**
 * Agent wiring (b5) doesn't exist yet, so there is no per-specialist tool subset to validate
 * `allowed-tools` against. The full `createMarketingTools()` registry is the closed set every
 * specialist's real tool subset will be drawn from, so it is the strictest check available
 * pre-b5: any name outside it can never resolve for any specialist once wiring lands.
 */
function fullToolSurface(): Set<string> {
  const tools = createMarketingTools({
    db: unusedDb,
    resolveScope: () => ({ workspaceId: 'unused', principalId: 'unused' }),
    storageRoot: '/tmp/unused',
    surfaces: ['blog', 'x', 'linkedin', 'threads', 'bluesky', 'mastodon'],
  });
  return new Set(Object.keys(tools));
}

describe('every allowed-tools entry names a real tool', () => {
  it('the full tool surface has more than a token number of tools (the check is real)', () => {
    expect(fullToolSurface().size).toBeGreaterThanOrEqual(19);
  });

  it('every skill.allowedTools entry exists in createMarketingTools()', async () => {
    const registered = fullToolSurface();
    const skills = await packageAllSkills();
    for (const skill of skills) {
      for (const toolName of skill.allowedTools ?? []) {
        expect(registered.has(toolName), `${skill.name}: unknown tool "${toolName}"`).toBe(true);
      }
    }
  });

  it('at least one skill actually declares allowed-tools (the loop above checks something)', async () => {
    const skills = await packageAllSkills();
    const withAllowedTools = skills.filter((s) => (s.allowedTools?.length ?? 0) > 0);
    expect(withAllowedTools.length).toBeGreaterThanOrEqual(1);
  });

  it('no skill declares an empty allowed-tools list (ambiguous; must be omitted instead)', async () => {
    const skills = await packageAllSkills();
    for (const skill of skills) {
      if (skill.allowedTools) {
        expect(skill.allowedTools.length, `${skill.name}: allowedTools: []`).toBeGreaterThan(0);
      }
    }
  });
});
