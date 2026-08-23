import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LoggedEvent } from '@kuralle-agents/client';
import type { TurnResult } from '../src/turnResult.js';

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '../dist/cli.js');
const contractAgent = join(here, 'fixtures/contract-agent.ts');

function runKuralle(args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], {
    env: { ...process.env, OPENAI_API_KEY: 'test-key' },
    encoding: 'utf8',
    input: '',
  });
}

describe('stream mode', () => {
  it('emits one JSON object per line with TurnResult last', () => {
    const store = join(mkdtempSync(join(tmpdir(), 'kuralle-stream-')), 'sessions.json');
    const result = runKuralle([
      'send',
      '--agent', contractAgent,
      '--session', 'stream',
      '--store', store,
      '--stream',
      'hello',
    ]);
    expect(result.status).toBe(0);

    const lines = result.stdout.trim().split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(1);

    const eventLines = lines.slice(0, -1);
    for (const line of eventLines) {
      const event = JSON.parse(line) as LoggedEvent;
      expect(event).toHaveProperty('index');
      expect(event).toHaveProperty('part');
    }

    const turn = JSON.parse(lines.at(-1)!) as TurnResult;
    expect(turn.status).toBe('completed');
    expect(turn.message).toBe('Done.');
  });
});
