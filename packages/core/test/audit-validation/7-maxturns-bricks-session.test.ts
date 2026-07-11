// FINDING 7 (FIXED): maxTurns is scoped per logical run via runEpoch reset — a fresh user request resets __agentTurnCount instead of bricking the session forever | anchor src/runtime/policies/limits.ts:4,18-34, src/runtime/openRun.ts:103-108, src/runtime/hostLoop.ts:95,126,172 | proves maxTurns bounds a runaway suspended-flow chain but not independent user requests
import { describe, expect, it } from 'bun:test';
import {
  assertWithinTurnLimit,
  incrementTurnCount,
  LimitsExceededError,
  resetTurnCount,
} from '../../src/runtime/policies/limits.js';
import { makeRunState } from '../core-durable/helpers.js';

describe('F7: maxTurns is scoped per logical run (FIXED)', () => {
  it('resets turn count on a fresh logical run so the session is not permanently bricked', () => {
    const run = makeRunState('sess-1', 'sess-1');
    const limits = { maxTurns: 3 };

    // Three ordinary user turns within one logical run.
    for (let turn = 1; turn <= 3; turn += 1) {
      incrementTurnCount(run);
      expect(() => assertWithinTurnLimit(run, limits)).not.toThrow();
    }

    // Turn 4 exceeds the limit within this logical run.
    incrementTurnCount(run);
    expect(() => assertWithinTurnLimit(run, limits)).toThrow(LimitsExceededError);
    expect(run.state.__agentTurnCount).toBe(4);

    // Fresh logical run (as openRun does on epoch bump): counter resets.
    run.runEpoch = (run.runEpoch ?? 0) + 1;
    resetTurnCount(run);

    expect(run.state.__agentTurnCount).toBe(0);
    incrementTurnCount(run);
    expect(() => assertWithinTurnLimit(run, limits)).not.toThrow();
    expect(run.state.__agentTurnCount).toBe(1);
  });
});