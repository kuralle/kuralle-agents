import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  NODE_SKILL_BODY,
  NODE_SKILL_RESOURCE,
  runSkillRoundTrip,
} from './skill-workers.fixture.js';

describe('test:skill-workers', () => {
  it('MemorySkillStore loads byte-identically inside workerd', async () => {
    const result = await runSkillRoundTrip();
    expect(result.body).toBe(NODE_SKILL_BODY);
    expect(result.resource).toBe(NODE_SKILL_RESOURCE);
    void env;
  });
});
