import { describe, expect, it } from 'bun:test';
import { SkillsCapability } from '../../src/skills/SkillsCapability.js';

const store = {
  list: async () => [],
  loadBody: async () => '',
  loadResource: async () => '',
};

describe('available-skills catalog', () => {
  it('routes file-backed skills through load_skill without leaking a workspace path', () => {
    const cap = new SkillsCapability(store as never, [
      { name: 'triage', description: 'Classify by urgency.', path: '/skills/triage/SKILL.md' },
    ]);
    const text = cap.getPromptSections().map((s) => s.content).join('\n');
    expect(text).toContain('- triage: Classify by urgency.');
    expect(text).toContain('call load_skill');
    expect(text).not.toContain('/skills/triage/SKILL.md');
    expect(text).not.toContain('path:');
  });

  it('lists inline skills, which have no file', () => {
    const cap = new SkillsCapability(store as never, [
      { name: 'inline', description: 'Defined in code.' },
    ]);
    const text = cap.getPromptSections().map((s) => s.content).join('\n');
    expect(text).toContain('- inline: Defined in code.');
    expect(text).not.toContain('path:');
  });

  it('emits nothing when there are no skills', () => {
    expect(new SkillsCapability(store as never, []).getPromptSections()).toEqual([]);
  });
});
