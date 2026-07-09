import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  TranscriptReplay,
  ReplayAssertionError,
  readTranscriptDirectory,
} from '../dist/index.js';

function line(payload) {
  return `${JSON.stringify(payload)}\n`;
}

test('TranscriptReplay validates ordered event contracts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kuralle-eval-'));
  const file = join(dir, 'run.jsonl');
  await writeFile(
    file,
    [
      line({
        sessionId: 's1',
        agentId: 'a1',
        timestamp: '2026-02-15T00:00:00.000Z',
        part: { type: 'input', text: 'hello' },
      }),
      line({
        sessionId: 's1',
        agentId: 'a1',
        timestamp: '2026-02-15T00:00:01.000Z',
        part: {
          type: 'tool-call',
          toolCallId: 'tc-1',
          toolName: 'lookup',
          args: { q: 'x' },
        },
      }),
      line({
        sessionId: 's1',
        agentId: 'a1',
        timestamp: '2026-02-15T00:00:01.500Z',
        part: {
          type: 'tool-result',
          toolCallId: 'tc-1',
          toolName: 'lookup',
          result: { ok: true },
        },
      }),
      line({
        sessionId: 's1',
        agentId: 'a1',
        timestamp: '2026-02-15T00:00:02.000Z',
        part: { type: 'done', sessionId: 's1' },
        fullText: 'done',
      }),
    ].join(''),
    'utf8'
  );

  const replay = await TranscriptReplay.fromFile(file);
  replay
    .expectEventOrder(['input', 'tool-call', 'tool-result', 'done'])
    .expectToolCalled('lookup')
    .expectNoToolMismatches()
    .expectNoErrors()
    .expectDone();

  const stats = replay.stats();
  assert.equal(stats.totalEvents, 4);
  assert.equal(stats.byType['tool-call'], 1);
  assert.equal(stats.byType['tool-result'], 1);
});

test('TranscriptReplay detects tool mismatches', async () => {
  const replay = new TranscriptReplay([
    {
      sessionId: 's2',
      agentId: 'a1',
      timestamp: '2026-02-15T00:00:00.000Z',
      part: {
        type: 'tool-call',
        toolCallId: 'tc-2',
        toolName: 'search',
      },
    },
    {
      sessionId: 's2',
      agentId: 'a1',
      timestamp: '2026-02-15T00:00:01.000Z',
      part: {
        type: 'tool-result',
        toolCallId: 'tc-2',
        toolName: 'different_name',
      },
    },
  ]);

  assert.throws(
    () => replay.expectNoToolMismatches(),
    error => error instanceof ReplayAssertionError
      && error.message.includes('nameMismatches=1')
  );
});

test('readTranscriptDirectory loads and time-sorts events across files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kuralle-eval-dir-'));
  const transcriptsDir = join(dir, 'transcripts');
  await mkdir(transcriptsDir, { recursive: true });

  await writeFile(
    join(transcriptsDir, 'b.jsonl'),
    line({
      sessionId: 's3',
      agentId: 'a1',
      timestamp: '2026-02-15T00:00:02.000Z',
      part: { type: 'done', sessionId: 's3' },
    }),
    'utf8'
  );

  await writeFile(
    join(transcriptsDir, 'a.jsonl'),
    line({
      sessionId: 's3',
      agentId: 'a1',
      timestamp: '2026-02-15T00:00:01.000Z',
      part: { type: 'input', text: 'hey' },
    }),
    'utf8'
  );

  const events = await readTranscriptDirectory(transcriptsDir);
  assert.equal(events.length, 2);
  assert.equal(events[0].part.type, 'input');
  assert.equal(events[1].part.type, 'done');
});
