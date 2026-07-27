import { describe, expect, it } from 'bun:test';
import { composeSystem } from '../../src/flow/nodeBuilders.js';

/**
 * Kuralle already batches parallel-safe tool calls that arrive in ONE model response
 * (`dispatchModelToolCalls` runs them concurrently and fires a single follow-up completion).
 * But nothing ever told the model to emit them together — so it issued them one per
 * response, and the batching machinery never fired.
 *
 * Measured: one user turn spent ~10,400 ms on six sequential tool round-trips before its
 * flow even started, at ~1.7 s each. Tool execution across the whole turn was 15 ms.
 *
 * The instruction is framework-owned and constant, so it belongs in the STABLE head where
 * it is covered by the cache breakpoint rather than re-billed every turn.
 */
describe('parallel-tool instruction', () => {
  it('is present in the stable head', () => {
    const [head] = composeSystem('Base instructions.', '', {}, undefined, undefined);
    expect(String(head?.content)).toContain('one response');
  });

  it('is byte-stable across turns, so it stays inside the cached prefix', () => {
    const a = composeSystem('Base.', '', {}, undefined, undefined);
    const b = composeSystem('Base.', 'a node prompt appears', {}, undefined, 'memory changed');
    expect(String(b[0]?.content)).toBe(String(a[0]?.content));
  });

  it('is omitted when there are no instructions at all', () => {
    expect(composeSystem(undefined, '', {}, undefined, undefined)).toEqual([]);
  });
});
