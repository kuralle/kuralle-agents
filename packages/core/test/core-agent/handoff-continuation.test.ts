import { describe, expect, it } from 'bun:test';
import type { Instructions } from '../../src/types/agentConfig.js';
import {
  applyHandoffContinuation,
  HANDOFF_CONTINUATION_DIRECTIVE,
} from '../../src/runtime/handoffContinuation.js';

describe('silent handoff continuation directive', () => {
  it('appends the directive to string instructions (persona preserved)', () => {
    const out = applyHandoffContinuation('You are Bill from billing.');
    expect(typeof out).toBe('string');
    expect(out as string).toContain('You are Bill from billing.');
    expect(out as string).toContain(HANDOFF_CONTINUATION_DIRECTIVE);
    // directive comes AFTER the persona
    expect((out as string).indexOf('Bill')).toBeLessThan((out as string).indexOf(HANDOFF_CONTINUATION_DIRECTIVE));
  });

  it('wraps a (sync) function form, appending the directive to its resolved text', () => {
    const fn = applyHandoffContinuation((ctx: { state: Record<string, unknown> }) => `flow=${ctx.state.f}`);
    expect(typeof fn).toBe('function');
    const resolved = (fn as (c: { state: Record<string, unknown> }) => string)({ state: { f: 'order' } });
    expect(resolved).toContain('flow=order');
    expect(resolved).toContain(HANDOFF_CONTINUATION_DIRECTIVE);
  });

  it('preserves an AgentPrompt object rather than dropping it', () => {
    // A non-string, non-function Instructions form (stand-in for an AgentPrompt) is
    // returned untouched — the persona is never dropped.
    const prompt = { render: () => 'persona' } as unknown as Instructions;
    expect(applyHandoffContinuation(prompt)).toBe(prompt);
  });

  it('yields the directive alone when instructions are undefined', () => {
    expect(applyHandoffContinuation(undefined)).toBe(HANDOFF_CONTINUATION_DIRECTIVE);
  });
});
