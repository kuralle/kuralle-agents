import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { execSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TurnResult } from '../src/turnResult.js';

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = join(here, '..');
const cli = join(cliRoot, 'dist/cli.js');
const approvalAgent = join(here, 'fixtures/approval-agent.ts');

function runKuralle(args: string[], input = '') {
  return spawnSync(process.execPath, [cli, ...args], {
    env: { ...process.env, OPENAI_API_KEY: 'test-key' },
    encoding: 'utf8',
    input,
  });
}

describe('approval via --resume --respond', () => {
  it('parks on needsApproval, then --respond completes the turn', () => {
    const store = join(mkdtempSync(join(tmpdir(), 'kuralle-approval-')), 'sessions.json');
    const base = [
      'send',
      '--agent', approvalAgent,
      '--session', 'book',
      '--store', store,
    ];

    const parked = runKuralle([...base, 'book a table for four']);
    expect(parked.status).toBe(3);
    const paused = JSON.parse(parked.stdout.trim()) as TurnResult;
    expect(paused.status).toBe('input-required');
    expect(paused.requests?.[0]?.requestId).toBe('req-approve-1');

    const respondJson = JSON.stringify([{
      requestId: paused.requests![0]!.requestId,
      decision: 'approve',
    }]);
    const completed = runKuralle([...base, '--resume', '--respond', respondJson], parked.stdout);
    expect(completed.status).toBe(0);
    const result = JSON.parse(completed.stdout.trim()) as TurnResult;
    expect(result.status).toBe('completed');
    expect(result.message).toContain('Booked for four.');
  });

  it('does not reach into the session store durableRuns shape from cli/src', () => {
    const hits = execSync('grep -rn durableRuns src || true', { cwd: cliRoot, encoding: 'utf8' });
    expect(hits.trim()).toBe('');
  });
});
