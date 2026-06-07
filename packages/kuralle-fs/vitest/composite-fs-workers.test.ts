import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  COMPOSITE_READ_CONTENT,
  COMPOSITE_SCRATCH_CONTENT,
  runCompositeWorkspaceRoundTrip,
} from './composite-fs-workers.fixture.js';

describe('test:composite-fs-workers', () => {
  it('CompositeFileSystem over two InMemoryFs mounts round-trips inside workerd', async () => {
    const result = await runCompositeWorkspaceRoundTrip();
    expect(result.readContent).toBe(COMPOSITE_READ_CONTENT);
    expect(result.scratchContent).toBe(COMPOSITE_SCRATCH_CONTENT);
    void env;
  });
});
