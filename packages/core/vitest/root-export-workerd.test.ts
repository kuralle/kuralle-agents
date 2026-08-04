import { describe, expect, it } from 'vitest';
// Imports through the PACKAGE ROOT (not deep source paths), which is the path a
// Worker consumer actually writes. Proves the new packaged-skill API is reachable
// from `@kuralle-agents/core` inside workerd, not merely from its own module file.
import { brandPackagedSkill, packagedSkillStore } from '../src/index.js';

describe('test:packaged-skill root export on workerd', () => {
  it('loads a packaged skill imported through the package root', async () => {
    const md = '---\nname: rooted\ndescription: Root export probe.\n---\n\nROOT_BODY';
    const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(md)));
    const store = packagedSkillStore([
      brandPackagedSkill({
        id: 'skill:rooted:0',
        name: 'rooted',
        description: 'Root export probe.',
        files: { 'SKILL.md': { path: 'SKILL.md', encoding: 'base64', kind: 'text', content: b64 } },
      }),
    ]);
    expect(await store.loadBody('rooted')).toContain('ROOT_BODY');
  });
});
