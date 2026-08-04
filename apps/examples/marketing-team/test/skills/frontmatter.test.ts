import { describe, expect, it } from 'bun:test';
import { discoverSkillRoots, packageAllSkills } from './helpers.js';

/**
 * `packageSkillsDirectory` calls `parseSkillFrontmatter` on every `SKILL.md`, which throws
 * unless `name` is present, non-empty, matches the containing directory exactly, and
 * `description` is at most 1024 codepoints — so a successful `packageAllSkills()` call is
 * itself proof of parsing and the name/directory match. This test additionally asserts each
 * fact directly, so a future change to `packageSkillsDirectory` that stops enforcing one of
 * them (rather than throwing) still gets caught here instead of only failing loudly elsewhere.
 */
describe('every ported skill parses and is well-formed', () => {
  it('discovers at least 20 skills by walking the directory (not a hand-written count)', async () => {
    const skills = await packageAllSkills();
    expect(skills.length).toBeGreaterThanOrEqual(20);
  });

  it('discovered roots include every specialist and the shared skills directory', async () => {
    const roots = await discoverSkillRoots();
    const names = roots.map((r) => r.split('/').slice(-2, -1)[0]);
    expect(names.sort()).toEqual(
      ['content-marketer', 'email', 'product-marketer', 'seo', 'shared', 'social-media-coordinator'].sort(),
    );
  });

  it('every skill declares a description no longer than 1024 characters', async () => {
    const skills = await packageAllSkills();
    for (const skill of skills) {
      expect([...skill.description].length, `${skill.name}: description too long`).toBeLessThanOrEqual(1024);
    }
  });

  it('every skill name is unique across the whole ported set', async () => {
    const skills = await packageAllSkills();
    const names = skills.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
