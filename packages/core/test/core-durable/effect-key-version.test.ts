import { describe, expect, it } from 'bun:test';
import {
  assertResumableEffectKeys,
  EFFECT_KEY_VERSION,
} from '../../src/runtime/durable/effectKeyVersion.js';
import type { RunState, StepRecord } from '../../src/runtime/durable/types.js';

// Scoping effect keys by flow changed the journal's key scheme. A run that was journaled
// under the old scheme and is still inside a flow would not find its own recorded steps,
// so every effect it already performed would run a second time — a real payment, a real
// dispatch. Exactly-once cannot be silently traded for an upgrade, so such a run is
// refused by name instead.
describe('effect key version', () => {
  const step = { index: 0, key: 'k', kind: 'tool', status: 'finished' } as unknown as StepRecord;
  const run = (over: Partial<RunState>): RunState =>
    ({ runId: 'r', state: {}, ...over }) as unknown as RunState;

  it('refuses an in-flow run journaled under the old scheme', () => {
    expect(() =>
      assertResumableEffectKeys(run({ activeFlow: 'checkout' }), [step]),
    ).toThrow(/effect-key/i);
  });

  it('allows an in-flow run journaled under the current scheme', () => {
    expect(() =>
      assertResumableEffectKeys(
        run({ activeFlow: 'checkout', effectKeyVersion: EFFECT_KEY_VERSION }),
        [step],
      ),
    ).not.toThrow();
  });

  it('allows an old run that is not inside a flow', () => {
    // Outside a flow the key is unchanged, so those journals still resolve.
    expect(() => assertResumableEffectKeys(run({}), [step])).not.toThrow();
  });

  it('allows an in-flow run with nothing journaled yet', () => {
    // Nothing recorded means nothing to mis-key; the run adopts the current scheme.
    expect(() => assertResumableEffectKeys(run({ activeFlow: 'checkout' }), [])).not.toThrow();
  });
});
