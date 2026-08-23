import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '../dist/cli.js');

/**
 * A provider error rejects the turn rather than arriving as an `error` part, so it used to escape
 * runSend entirely: stack trace on stderr, stdout EMPTY, exit 1. The exit code was right and the
 * contract was broken — an agent reads stdout and got nothing to parse.
 *
 * Every existing exit-code test uses a fixture whose runtime produces a clean `failed` scenario.
 * None of them throws, which is why this path had no coverage.
 */
describe('a provider failure is still a TurnResult', () => {
  it('prints failed JSON on stdout and exits 1 when the model rejects', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kuralle-provider-'));
    const agent = join(here, 'fixtures/throwing-model-agent.ts');

    const result = spawnSync(process.execPath, [
      cli, 'send', '--agent', agent, '--session', 'p', '--store', join(dir, 's.json'), 'hi',
    ], { env: { ...process.env, OPENAI_API_KEY: 'bad-key' }, encoding: 'utf8', input: '' });

    expect(result.status).toBe(1);
    expect(result.stdout.trim()).not.toBe('');
    const parsed = JSON.parse(result.stdout) as { status: string; message?: string };
    expect(parsed.status).toBe('failed');
    expect(parsed.message).toBeTruthy();
  });
});
