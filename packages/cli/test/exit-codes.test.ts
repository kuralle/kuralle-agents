import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '../dist/cli.js');
const contractAgent = join(here, 'fixtures/contract-agent.ts');

function runKuralle(args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
    input: '',
  });
}

function tmpAgent(scenario: 'completed' | 'waiting' | 'input-required' | 'escalated' | 'failed'): string {
  const dir = mkdtempSync(join(tmpdir(), 'kuralle-exit-'));
  const path = join(dir, 'agent.ts');
  writeFileSync(path, `
    import { buildContractRuntime } from '${contractAgent}';
    export const buildRuntime = buildContractRuntime('${scenario}');
  `);
  return path;
}

describe('exit codes', () => {
  it('exit 0 for completed', () => {
    const store = join(mkdtempSync(join(tmpdir(), 'kuralle-exit-')), 's.json');
    const result = runKuralle([
      'send', '--agent', tmpAgent('completed'), '--session', 's', '--store', store, 'hi',
    ], { OPENAI_API_KEY: 'test-key' });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).status).toBe('completed');
  });

  it('exit 0 for waiting', () => {
    const store = join(mkdtempSync(join(tmpdir(), 'kuralle-exit-')), 's.json');
    const result = runKuralle([
      'send', '--agent', contractAgent, '--session', 's', '--store', store, '--state',
    ], { OPENAI_API_KEY: 'test-key' });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).status).toBe('waiting');
  });

  it('exit 1 for failed', () => {
    const store = join(mkdtempSync(join(tmpdir(), 'kuralle-exit-')), 's.json');
    const result = runKuralle([
      'send', '--agent', tmpAgent('failed'), '--session', 's', '--store', store, 'hi',
    ], { OPENAI_API_KEY: 'test-key' });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).status).toBe('failed');
  });

  it('exit 2 for usage error', () => {
    const store = join(mkdtempSync(join(tmpdir(), 'kuralle-exit-')), 's.json');
    const result = runKuralle([
      'send', '--agent', contractAgent, '--session', 's', '--store', store,
    ], { OPENAI_API_KEY: 'test-key' });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('pass a message');
  });

  it('exit 3 for input-required', () => {
    const store = join(mkdtempSync(join(tmpdir(), 'kuralle-exit-')), 's.json');
    const result = runKuralle([
      'send', '--agent', tmpAgent('input-required'), '--session', 's', '--store', store, 'hi',
    ], { OPENAI_API_KEY: 'test-key' });
    expect(result.status).toBe(3);
    expect(JSON.parse(result.stdout).status).toBe('input-required');
  });

  it('exit 3 for auth-required', () => {
    const store = join(mkdtempSync(join(tmpdir(), 'kuralle-exit-')), 's.json');
    const env = { ...process.env };
    delete env.OPENAI_API_KEY;
    const result = runKuralle([
      'send', '--session', 's', '--store', store, 'hi',
    ], env);
    expect(result.status).toBe(3);
    expect(JSON.parse(result.stdout).status).toBe('auth-required');
  });
});
