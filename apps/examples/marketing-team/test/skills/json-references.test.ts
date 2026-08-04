import { describe, expect, it } from 'bun:test';
import { packageAllSkills } from './helpers.js';

/**
 * `lint_against_style` throws a tool error at runtime if a skill's `references/*.json`
 * sibling fails to parse (b3 made the lint fail closed instead of silently reporting clean).
 * Catching a malformed JSON reference here, at packaging/build time, is strictly cheaper than
 * finding out the first time an agent runs the lint tool.
 */
describe('every references/*.json sibling is valid JSON', () => {
  it('parses every packaged .json file without throwing', async () => {
    const skills = await packageAllSkills();
    let checked = 0;
    for (const skill of skills) {
      for (const [path, file] of Object.entries(skill.files)) {
        if (!path.endsWith('.json')) continue;
        checked += 1;
        const raw = file.encoding === 'base64' ? Buffer.from(file.content, 'base64').toString('utf8') : file.content;
        expect(() => JSON.parse(raw), `${skill.name}: ${path} is not valid JSON`).not.toThrow();
      }
    }
    // Every social/blog style skill ships a references/banned-words.json, so this must be > 0
    // or the loop above is silently checking nothing.
    expect(checked).toBeGreaterThan(0);
  });

  it('every banned-words.json is an array of strings (what lint_against_style requires)', async () => {
    const skills = await packageAllSkills();
    let checked = 0;
    for (const skill of skills) {
      const file = skill.files['references/banned-words.json'];
      if (!file) continue;
      checked += 1;
      const raw = file.encoding === 'base64' ? Buffer.from(file.content, 'base64').toString('utf8') : file.content;
      const parsed = JSON.parse(raw);
      expect(Array.isArray(parsed), `${skill.name}: banned-words.json is not an array`).toBe(true);
      expect(
        parsed.every((item: unknown) => typeof item === 'string'),
        `${skill.name}: banned-words.json has a non-string entry`,
      ).toBe(true);
    }
    expect(checked).toBeGreaterThan(0);
  });
});
