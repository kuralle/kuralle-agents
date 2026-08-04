import { describe, expect, it } from 'bun:test';
import { packageSkillsDirectory } from '@kuralle-agents/build';
import { discoverSkillRoots } from './helpers.js';

/**
 * `computeSkillId` hashes every packaged file's path and content, so packaging the same
 * directory twice must produce byte-identical ids — that determinism is what makes a
 * packaged skill cacheable and diffable. There are no secrets in these fixtures (they are
 * marketing prose and reference tables), so packaging must refuse nothing.
 */
describe('packaging is deterministic and refuses nothing', () => {
  it('packaging the same root twice produces identical skill ids', async () => {
    const roots = await discoverSkillRoots();
    for (const root of roots) {
      const first = await packageSkillsDirectory(root);
      const second = await packageSkillsDirectory(root);
      expect(second.map((s) => s.id)).toEqual(first.map((s) => s.id));
    }
  });

  it('packaging every root resolves without throwing (no refusals: no secrets in these fixtures)', async () => {
    const roots = await discoverSkillRoots();
    await expect(Promise.all(roots.map((root) => packageSkillsDirectory(root)))).resolves.toBeDefined();
  });

  it('every packaged skill carries at least one file', async () => {
    const roots = await discoverSkillRoots();
    const all = (await Promise.all(roots.map((root) => packageSkillsDirectory(root)))).flat();
    for (const skill of all) {
      expect(Object.keys(skill.files).length, `${skill.name}: no files packaged`).toBeGreaterThan(0);
    }
  });
});
