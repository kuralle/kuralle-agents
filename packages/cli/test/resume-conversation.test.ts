import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TurnResult } from '../src/turnResult.js';

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '../dist/cli.js');
const multiTurnAgent = join(here, 'fixtures/multi-turn-agent.ts');

function runKuralle(args: string[], input = '') {
  return spawnSync(process.execPath, [cli, ...args], {
    env: { ...process.env, OPENAI_API_KEY: 'test-key' },
    encoding: 'utf8',
    input,
  });
}

function parseResult(stdout: string): TurnResult {
  return JSON.parse(stdout.trim()) as TurnResult;
}

function assistantTexts(result: TurnResult): string[] {
  if (!('view' in result)) return [];
  return result.view.blocks
    .filter((block): block is Extract<typeof block, { kind: 'assistant' }> => block.kind === 'assistant')
    .map((block) => block.text);
}

describe('resume conversation across processes', () => {
  it('three resume invocations accumulate a multi-turn transcript', () => {
    const store = join(mkdtempSync(join(tmpdir(), 'kuralle-resume-')), 'sessions.json');
    const base = [
      'send',
      '--agent', multiTurnAgent,
      '--session', 'conv',
      '--store', store,
    ];

    const t1 = runKuralle([...base, 'turn 1']);
    expect(t1.status).toBe(0);
    let piped = t1.stdout;
    expect(assistantTexts(parseResult(piped))).toEqual(['reply 1: turn 1']);

    const prompts = ['turn 2', 'turn 3', 'turn 4'];
    let previous = parseResult(piped);
    for (const prompt of prompts) {
      const next = runKuralle([...base, '--resume', prompt], piped);
      expect(next.status).toBe(0);
      piped = next.stdout;
      previous = parseResult(piped);
    }

    expect(assistantTexts(previous)).toEqual([
      'reply 1: turn 1',
      'reply 2: turn 2',
      'reply 3: turn 3',
      'reply 4: turn 4',
    ]);
  });

  it('message carries only this turn, while view carries the whole transcript', () => {
    // The view is cumulative on purpose — it is the transcript. `message` is not: it is the
    // one field an agent driving the CLI reads to decide what to say next, and joining every
    // assistant block re-emitted all four replies glued together with no separator.
    const store = join(mkdtempSync(join(tmpdir(), 'kuralle-resume-')), 'sessions.json');
    const base = ['send', '--agent', multiTurnAgent, '--session', 'scoped', '--store', store];

    let piped = runKuralle([...base, 'turn 1']).stdout;
    expect(parseResult(piped).message).toBe('reply 1: turn 1');

    for (const [index, prompt] of ['turn 2', 'turn 3'].entries()) {
      piped = runKuralle([...base, '--resume', prompt], piped).stdout;
      const result = parseResult(piped);
      expect(result.message).toBe(`reply ${index + 2}: ${prompt}`);
      expect(assistantTexts(result)).toHaveLength(index + 2);
    }
  });
});
