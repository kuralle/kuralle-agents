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
    // Deleting the key is not enough: resolveModel.ts loads the repo .env through dotenv, which
    // repopulates it. .env is gitignored, so a deleted key made this test pass in a fresh worktree
    // and fail in any real checkout. An empty string is present-but-falsy, so dotenv leaves it
    // alone and resolveCliModel still treats it as missing.
    const env = { ...process.env, OPENAI_API_KEY: '', OPENAI_MODEL: '' };
    const result = runKuralle([
      'send', '--session', 's', '--store', store, 'hi',
    ], env);
    expect(result.status).toBe(3);
    expect(JSON.parse(result.stdout).status).toBe('auth-required');
  });
});

describe('usage errors are distinguishable from failed turns', () => {
  // Commander exits 1 by default, which collides with the contract's "the turn failed".
  const run = (args: string[]): number => {
    const proc = Bun.spawnSync(['node', 'dist/cli.js', ...args], {
      cwd: new URL('..', import.meta.url).pathname,
      stdin: 'ignore',
    });
    return proc.exitCode ?? -1;
  };

  it('an unknown command exits 2, not 1', () => {
    expect(run(['definitely-not-a-command'])).toBe(2);
  });

  it('--help and schema exit 0', () => {
    expect(run(['--help'])).toBe(0);
    expect(run(['schema'])).toBe(0);
  });

  it('chat exits 2 pointing at kuralle-tui', () => {
    expect(run(['chat'])).toBe(2);
  });
});
