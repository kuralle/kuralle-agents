import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  NODE_WORKSPACE_CONTENT,
  runWorkspaceRoundTrip,
} from './fs-workers.fixture.js';

describe('test:fs-workers', () => {
  it('InMemoryFs + createFsTool round-trip inside workerd', async () => {
    const result = await runWorkspaceRoundTrip();
    expect(result.content).toBe(NODE_WORKSPACE_CONTENT);
    void env;
  });
});
