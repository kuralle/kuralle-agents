import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  FS_SKILL_BODY,
  SKILL_BODY,
  SKILL_RESOURCE,
  runFsRoundTrip,
  runInlineRoundTrip,
  runPathSourceRoundTrip,
} from './skill-workers.fixture.js';

/**
 * Skills moved from `@kuralle-agents/skills` into core, which carried a workerd parity test
 * with it. Restored here and widened: core now owns the `SKILL.md` parser and the fs-backed
 * store too, so all three have to hold on workerd, not just the inline store.
 */
describe('test:skill-workers', () => {
  it('InlineSkillStore loads byte-identically inside workerd', async () => {
    const result = await runInlineRoundTrip();
    expect(result.body).toBe(SKILL_BODY);
    expect(result.resource).toBe(SKILL_RESOURCE);
    void env;
  });

  it('the SKILL.md parser and fsSkillStore run on workerd', async () => {
    const result = await runFsRoundTrip();
    expect(result.names).toEqual(['returns-policy']);
    expect(result.body).toBe(FS_SKILL_BODY);
  });

  it('resolves a workspace path source on workerd', async () => {
    expect(await runPathSourceRoundTrip()).toEqual(['returns-policy']);
  });
});
