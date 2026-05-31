import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  registerScorer,
  clearScorers,
  listScorers,
  getScorer,
  runGoldenSuite,
  TranscriptReplay,
} from '../dist/index.js';

test('registerScorer + getScorer round-trip', () => {
  clearScorers();
  const scorer = { score: () => ({ pass: true, score: 1 }) };
  registerScorer('my-scorer', scorer);
  assert.equal(getScorer('my-scorer'), scorer);
  assert.deepEqual(listScorers(), ['my-scorer']);
  clearScorers();
});

test('clearScorers empties the registry', () => {
  registerScorer('a', { score: () => ({ pass: true, score: 1 }) });
  registerScorer('b', { score: () => ({ pass: true, score: 1 }) });
  clearScorers();
  assert.deepEqual(listScorers(), []);
});

test('golden suite dispatches to registered scorer and fails on pass=false', async () => {
  clearScorers();
  registerScorer('failing', {
    score: () => ({ pass: false, score: 0, reason: 'nope' }),
  });

  const dir = await mkdtemp(join(tmpdir(), 'kuralle-eval-scorer-'));
  const transcriptPath = join(dir, 'run.jsonl');
  await writeFile(transcriptPath,
    `${JSON.stringify({ timestamp: '2026-01-01T00:00:00.000Z', sessionId: 's', agentId: 'a', part: { type: 'done' } })}\n`,
  );

  const manifestPath = join(dir, 'manifest.json');
  await writeFile(manifestPath, JSON.stringify([
    {
      name: 'uses failing scorer',
      file: 'run.jsonl',
      expectDone: true,
      expectNoErrors: true,
      expectNoToolMismatches: false,
      scorers: [{ name: 'failing' }],
    },
  ]));

  const result = await runGoldenSuite(manifestPath);
  assert.equal(result.failed, 1);
  assert.match(result.failures[0].error, /failing/);
  clearScorers();
});

test('golden suite passes when scorer returns pass=true', async () => {
  clearScorers();
  registerScorer('passing', {
    score: () => ({ pass: true, score: 1 }),
  });

  const dir = await mkdtemp(join(tmpdir(), 'kuralle-eval-scorer-'));
  const transcriptPath = join(dir, 'run.jsonl');
  await writeFile(transcriptPath,
    `${JSON.stringify({ timestamp: '2026-01-01T00:00:00.000Z', sessionId: 's', agentId: 'a', part: { type: 'done' } })}\n`,
  );

  const manifestPath = join(dir, 'manifest.json');
  await writeFile(manifestPath, JSON.stringify([
    {
      name: 'uses passing scorer',
      file: 'run.jsonl',
      expectDone: true,
      expectNoErrors: true,
      expectNoToolMismatches: false,
      scorers: [{ name: 'passing' }],
    },
  ]));

  const result = await runGoldenSuite(manifestPath);
  assert.equal(result.failed, 0);
  assert.equal(result.passed, 1);
  clearScorers();
});

test('missing scorer fails the case with a clear error', async () => {
  clearScorers();
  const dir = await mkdtemp(join(tmpdir(), 'kuralle-eval-scorer-'));
  const transcriptPath = join(dir, 'run.jsonl');
  await writeFile(transcriptPath,
    `${JSON.stringify({ timestamp: '2026-01-01T00:00:00.000Z', sessionId: 's', agentId: 'a', part: { type: 'done' } })}\n`,
  );
  const manifestPath = join(dir, 'manifest.json');
  await writeFile(manifestPath, JSON.stringify([
    {
      name: 'uses unknown scorer',
      file: 'run.jsonl',
      expectDone: true,
      expectNoErrors: true,
      expectNoToolMismatches: false,
      scorers: [{ name: 'not-registered' }],
    },
  ]));
  const result = await runGoldenSuite(manifestPath);
  assert.equal(result.failed, 1);
  assert.match(result.failures[0].error, /not registered/);
});

test('expectToolCalled error message includes tools actually called', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kuralle-eval-scorer-'));
  const file = join(dir, 'run.jsonl');
  await writeFile(file,
    [
      JSON.stringify({ timestamp: '2026-01-01T00:00:00.000Z', sessionId: 's', agentId: 'a', part: { type: 'tool-call', toolName: 'other', toolCallId: 'c1' } }),
    ].join('\n') + '\n',
  );
  const replay = await TranscriptReplay.fromFile(file);
  try {
    replay.expectToolCalled('expected');
    assert.fail('should have thrown');
  } catch (err) {
    assert.match(err.message, /Tools actually called: other/);
  }
});
