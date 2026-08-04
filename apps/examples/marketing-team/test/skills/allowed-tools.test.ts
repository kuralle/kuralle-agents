import { describe, expect, it } from 'bun:test';
import { buildAllAgents, flattenSkills, toolNames } from '../agents/helpers.js';
import { packageAllSkills } from './helpers.js';

describe('every allowed-tools entry names a real tool', () => {
  it('at least one skill actually declares allowed-tools (the loop below checks something)', async () => {
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

  /**
   * Agent wiring (b5) now exists, so this checks each skill's `allowed-tools` against the ONE
   * tool surface it can actually run under: the specific specialist that loads it. Checking
   * against the full 19-tool registry (the pre-b5 version of this test) would pass a name that
   * belongs to a *different* specialist's surface — a check that doesn't mean anything once a
   * real per-specialist boundary exists.
   */
  it("every skill.allowedTools entry exists in the specialist that actually loads it", async () => {
    const { specialists } = await buildAllAgents();
    let checked = 0;
    for (const agent of specialists) {
      const surface = toolNames(agent);
      for (const skill of flattenSkills(agent.skills)) {
        for (const toolName of skill.allowedTools ?? []) {
          checked += 1;
          expect(
            surface.has(toolName),
            `${agent.id}/${skill.name}: "${toolName}" is not in ${agent.id}'s own tool surface`,
          ).toBe(true);
        }
      }
    }
    expect(checked).toBeGreaterThanOrEqual(2);
  });
});
