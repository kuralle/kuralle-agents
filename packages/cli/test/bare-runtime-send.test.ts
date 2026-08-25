/**
 * Bare Runtime exports (memory-concierge shape) must receive the CLI's file event log —
 * otherwise send reports an empty waiting view while the session store holds a reply.
 */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSend } from '../src/send.js';
import { resolveBuildRuntime } from '../src/agentLoader.js';

const here = dirname(fileURLToPath(import.meta.url));
const bareRuntimeAgent = join(here, 'fixtures/bare-runtime-agent.ts');

describe('test:cli-bare-runtime-send', () => {
  it('send returns a non-empty view for a bare Runtime export', async () => {
    const store = join(mkdtempSync(join(tmpdir(), 'kuralle-cli-bare-store-')), 'sessions.json');
    const build = await resolveBuildRuntime(bareRuntimeAgent);
    const result = await runSend(
      ['--session', 'smoke', '--store', store, 'Say the word ready and nothing else'],
      build,
    );
    expect(result.status).toBe('completed');
    expect(result.view?.blocks.length).toBeGreaterThan(0);
    expect(result.view?.startedAt).not.toBeNull();
  });
});
