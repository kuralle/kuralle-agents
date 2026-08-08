import { describe, expect, it } from 'bun:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fsSkillStore } from '@kuralle-agents/core';
import { loadFixtureIntoMemoryFs } from './fixture-fs.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const remotionFixture = join(__dirname, 'fixtures/remotion-codex-plugin');

const EXPECTED_SKILL_NAMES = [
  'remotion-best-practices',
  'remotion-captions',
  'remotion-create',
  'remotion-docs',
  'remotion-interactivity',
  'remotion-maps',
  'remotion-markup',
  'remotion-multimedia',
  'remotion-render',
  'remotion-saas',
  'remotion-studio',
  'remotion-upgrade',
];

describe('remotion-codex-plugin skills regression', () => {
  it('discovers exactly 12 top-level skills from the vendored fixture', async () => {
    const { fs, root } = await loadFixtureIntoMemoryFs(remotionFixture);
    const store = fsSkillStore(fs, [`${root}/skills`]);

    const skills = await store.list();
    expect(skills).toHaveLength(12);
    expect(skills.map((skill) => skill.name).sort()).toEqual(
      [...EXPECTED_SKILL_NAMES].sort(),
    );
  });

  it('returns non-empty descriptions and content hashes for every discovered skill', async () => {
    const { fs, root } = await loadFixtureIntoMemoryFs(remotionFixture);
    const store = fsSkillStore(fs, [`${root}/skills`]);

    const skills = await store.list();
    for (const skill of skills) {
      expect(skill.description.length).toBeGreaterThan(0);
      expect(skill.contentHash).toBeDefined();
      expect(skill.contentHash!.length).toBeGreaterThan(0);
    }
  });

  it('does not treat nested SKILL.md files inside skill directories as separate skills', async () => {
    const { fs, root } = await loadFixtureIntoMemoryFs(remotionFixture);
    const store = fsSkillStore(fs, [`${root}/skills`]);

    const skills = await store.list();
    const names = new Set(skills.map((skill) => skill.name));

    expect(names.size).toBe(12);
    expect(names.has('nested')).toBe(false);
    expect(names.has('deep')).toBe(false);
    expect(names.has('techniques')).toBe(false);
    expect(names.has('cesium')).toBe(false);
  });
});
