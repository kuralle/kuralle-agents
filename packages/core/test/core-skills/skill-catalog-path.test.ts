import { describe, expect, it } from 'bun:test';
import { SkillsCapability } from '../../src/skills/SkillsCapability.js';

/**
 * The catalog names a skill and tells the model where to read it. Without the path the
 * model knows a skill exists but must infer its location — which is guessing, and the
 * failure mode we saw live was an agent asserting a rule was absent rather than reading
 * the file that held it.
 */
const store = {
  list: async () => [],
  loadBody: async () => '',
  loadResource: async () => '',
};

describe('available-skills catalog', () => {
  it('includes the path for file-backed skills', () => {
    const cap = new SkillsCapability(store as never, [
      { name: 'triage', description: 'Classify by urgency.', path: '/skills/triage/SKILL.md' },
    ]);
    const text = cap.getPromptSections().map((s) => s.content).join('\n');
    expect(text).toContain('- triage: Classify by urgency. (path: /skills/triage/SKILL.md)');
  });

  it('omits the path for inline skills, which have no file', () => {
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
