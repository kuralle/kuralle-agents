import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '../dist/cli.js');
const contractAgent = join(here, 'fixtures/contract-agent.ts');

function runKuralle(args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    env: { ...process.env, ...env, OPENAI_API_KEY: env.OPENAI_API_KEY ?? 'test-key' },
    encoding: 'utf8',
    input: '',
  });
}

function expectJsonStdout(result: ReturnType<typeof runKuralle>) {
  expect(result.stdout).not.toMatch(/\x1b\[/);
  expect(() => JSON.parse(result.stdout.trim())).not.toThrow();
  return JSON.parse(result.stdout.trim()) as unknown;
}

describe('output contract', () => {
  it('schema stdout is JSON without ANSI', () => {
    const result = runKuralle(['schema']);
    expect(result.status).toBe(0);
    const parsed = expectJsonStdout(result);
    expect(parsed).toHaveProperty('$schema');
    expect(parsed).toHaveProperty('title', 'kuralle turn result');
  });

  it('send --state stdout is JSON without ANSI', () => {
    const store = join(mkdtempSync(join(tmpdir(), 'kuralle-contract-')), 'sessions.json');
    const result = runKuralle([
      'send',
      '--agent', contractAgent,
      '--session', 'contract',
      '--store', store,
      '--state',
    ]);
    expect(result.status).toBe(0);
    const parsed = expectJsonStdout(result) as { status: string; cursor: { sessionId: string } };
    expect(parsed.status).toBe('waiting');
    expect(parsed.cursor.sessionId).toBe('contract');
  });

  it('send message stdout is JSON without ANSI', () => {
    const store = join(mkdtempSync(join(tmpdir(), 'kuralle-contract-')), 'sessions.json');
    const result = runKuralle([
      'send',
      '--agent', contractAgent,
      '--session', 'contract',
      '--store', store,
      'hello',
    ]);
    expect(result.status).toBe(0);
    const parsed = expectJsonStdout(result) as { status: string; message?: string };
    expect(parsed.status).toBe('completed');
    expect(parsed.message).toBe('Done.');
  });
});
