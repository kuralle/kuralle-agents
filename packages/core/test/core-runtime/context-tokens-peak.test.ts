import { describe, expect, it } from 'bun:test';
import { addTurnUsage } from '../../src/runtime/channels/TextDriver.js';

/**
 * `contextTokens` answers "how much of the window did this turn occupy?".
 *
 * It was assigned last-step-only while cacheRead/cacheWrite beside it accumulated, so a
 * multi-step turn reported whatever the FINAL step happened to send. Measured live: a turn
 * that sent 24,437 input tokens reported contextTokens 2,232 — smaller than the previous
 * turn's, on the largest turn of the conversation, because the last step was a small
 * extraction call.
 *
 * Summing would be equally wrong: a turn does not occupy 24k + 3k of window, it occupies
 * the largest single prompt it sent. So: peak.
 */
describe('contextTokens', () => {
  const step = (inputTokens: number) => ({
    inputTokens,
    outputTokens: 1,
    totalTokens: inputTokens + 1,
    inputTokenDetails: { cacheReadTokens: 0 },
  });

  it('reports the PEAK across a multi-step turn, not the last step', () => {
    let acc = addTurnUsage(undefined, step(7_000) as never);
    acc = addTurnUsage(acc, step(24_437) as never);   // the big one
    acc = addTurnUsage(acc, step(3_844) as never);    // small tail step

    expect(acc.contextTokens).toBe(24_437);
    // input still SUMS — that is spend, and it is a different question from occupancy.
    expect(acc.inputTokens).toBe(7_000 + 24_437 + 3_844);
  });

  it('equals inputTokens on a single-step turn', () => {
    const acc = addTurnUsage(undefined, step(1_234) as never);
    expect(acc.contextTokens).toBe(1_234);
  });
});
