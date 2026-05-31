import test from 'node:test';
import assert from 'node:assert/strict';
import { TokenAccumulator } from '../../dist/runtime/TokenAccumulator.js';

function baseTurn(overrides) {
  return {
    turn: 0,
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
    latencyMs: 1,
    ...overrides,
  };
}

test('TokenAccumulator: record aggregates cumulative totals', () => {
  const acc = new TokenAccumulator(1000);
  acc.record(baseTurn({ turn: 1 }));
  acc.record(baseTurn({ turn: 2, inputTokens: 20, outputTokens: 10, totalTokens: 30 }));
  const c = acc.cumulative;
  assert.strictEqual(c.inputTokens, 30);
  assert.strictEqual(c.outputTokens, 15);
  assert.strictEqual(c.totalTokens, 45);
  assert.strictEqual(acc.turns.length, 2);
  assert.strictEqual(acc.turns[1].cumulativeInputTokens, 30);
  assert.strictEqual(acc.turns[1].cumulativeTotalTokens, 45);
});

test('TokenAccumulator: context utilization uses cumulative input over window', () => {
  const acc = new TokenAccumulator(1000);
  acc.record(baseTurn({ turn: 1, inputTokens: 100, outputTokens: 0, totalTokens: 100 }));
  const u = acc.turns[0].contextUtilization;
  assert.strictEqual(u, 0.1);
});

test('TokenAccumulator: peakUtilization tracks max across turns', () => {
  const acc = new TokenAccumulator(1000);
  acc.record(baseTurn({ inputTokens: 100, outputTokens: 0, totalTokens: 100 }));
  acc.record(baseTurn({ inputTokens: 50, outputTokens: 0, totalTokens: 50 }));
  assert.strictEqual(acc.peakUtilization, 0.15);
});

test('TokenAccumulator: omits contextUtilization when window undefined', () => {
  const acc = new TokenAccumulator(undefined);
  acc.record(baseTurn({}));
  assert.strictEqual(acc.turns[0].contextUtilization, undefined);
});

test('TokenAccumulator: toSessionTraceFields matches cumulative and cache sum', () => {
  const acc = new TokenAccumulator(2000);
  acc.record(
    baseTurn({
      cacheReadTokens: 3,
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    }),
  );
  const fields = acc.toSessionTraceFields();
  assert.strictEqual(fields.totalInputTokens, 10);
  assert.strictEqual(fields.totalCacheReadTokens, 3);
  assert.strictEqual(fields.peakContextUtilization, 10 / 2000);
  assert.ok(Array.isArray(fields.perTurnUsage));
});
