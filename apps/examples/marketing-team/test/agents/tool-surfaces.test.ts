import { describe, expect, it } from 'bun:test';
import { createMarketingTools } from '../../agent/lib/index.js';
import { buildAllAgents, flattenSkills, testDeps, toolNames } from './helpers.js';
import { SPECIALIST_IDS } from '../../agent/specialists.js';

function fullToolSurface(): Set<string> {
  const { model: _model, ...toolDeps } = testDeps();
  const tools = createMarketingTools(toolDeps);
  return new Set(Object.keys(tools));
}

describe('b5: per-specialist tool surfaces (derived from the real agent definitions)', () => {
  it('every declared specialist tool name is a real tool (the full registry is the closed set)', async () => {
    const full = fullToolSurface();
    expect(full.size).toBeGreaterThanOrEqual(19);
    const { specialists } = await buildAllAgents();
    for (const agent of specialists) {
      for (const name of toolNames(agent)) {
        expect(full.has(name), `${agent.id}: unknown tool "${name}"`).toBe(true);
      }
    }
  });

  it('save_brand_context is reachable only by product-marketer (test 1)', async () => {
    const { bySpecialistId } = await buildAllAgents();
    expect(toolNames(bySpecialistId['product-marketer']).has('save_brand_context')).toBe(true);
    for (const id of SPECIALIST_IDS) {
      if (id === 'product-marketer') continue;
      expect(
        toolNames(bySpecialistId[id]).has('save_brand_context'),
        `${id} must not declare save_brand_context`,
      ).toBe(false);
    }
  });

  it('every specialist gets a genuine subset, not the full 19-tool registry', async () => {
    const full = fullToolSurface();
    const { specialists } = await buildAllAgents();
    for (const agent of specialists) {
      const names = toolNames(agent);
      expect(names.size, `${agent.id}: declares no tools`).toBeGreaterThan(0);
      expect(names.size, `${agent.id}: declares the full registry, not a subset`).toBeLessThan(full.size);
    }
  });

  it("the lead's tool surface does not include save_artifact (test 3)", async () => {
    const { lead } = await buildAllAgents();
    const names = toolNames(lead);
    expect(names.has('save_artifact'), 'lead must not declare save_artifact').toBe(false);
    expect(names.has('save_brand_context'), 'lead must not declare save_brand_context').toBe(false);
    expect(names.size).toBeGreaterThan(0);
  });

  it("every skill's allowed-tools name exists in that specialist's own tool surface (test 4)", async () => {
    const { specialists } = await buildAllAgents();
    let checkedAllowedTools = 0;
    let totalSkillInstances = 0;
    for (const agent of specialists) {
      const surface = toolNames(agent);
      const skills = flattenSkills(agent.skills);
      totalSkillInstances += skills.length;
      for (const skill of skills) {
        for (const toolName of skill.allowedTools ?? []) {
          checkedAllowedTools += 1;
          expect(
            surface.has(toolName),
            `${agent.id}/${skill.name}: allowed-tools names "${toolName}", which is not in ${agent.id}'s own tool surface`,
          ).toBe(true);
        }
      }
    }
    // A loop that never iterates proves nothing — confirm real data flowed through it.
    expect(totalSkillInstances).toBeGreaterThanOrEqual(20);
    expect(checkedAllowedTools).toBeGreaterThanOrEqual(2);
  });
});

// Exported for reuse by the sabotage-verification script (see runs/) without duplicating the
// full-registry construction. Not itself a test.
export { fullToolSurface };
