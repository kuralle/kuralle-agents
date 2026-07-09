// FINDING 7: the turn counter lives in session-lifetime run.state and is never reset, so limits.maxTurns is a cumulative lifetime cap — a long-lived session eventually fails on EVERY turn | anchor src/runtime/policies/limits.ts:4,18-34, src/runtime/hostLoop.ts:95,126,172 | proves maxTurns bricks long-lived sessions instead of guarding a single runaway turn
import { describe, expect, it } from 'bun:test';
import {
  assertWithinTurnLimit,
  incrementTurnCount,
  LimitsExceededError,
} from '../../src/runtime/policies/limits.js';
import { makeRunState } from '../core-durable/helpers.js';

describe('F7: maxTurns is cumulative across the session lifetime', () => {
  it('counter persists in run.state and is only ever incremented', () => {
    const run = makeRunState('sess-1', 'sess-1');
    const limits = { maxTurns: 3 };

    // Three ordinary user turns, each one hostLoop entry, spread over days.
    for (let turn = 1; turn <= 3; turn += 1) {
      incrementTurnCount(run);
      expect(() => assertWithinTurnLimit(run, limits)).not.toThrow();
    }

    // Turn 4 — a perfectly normal new user message. The session is now
    // permanently dead: every future turn throws, forever.
    incrementTurnCount(run);
    expect(() => assertWithinTurnLimit(run, limits)).toThrow(LimitsExceededError);

    // Nothing resets it: the counter survives in the persisted state bag.
    expect(run.state.__agentTurnCount).toBe(4);
  });
});
