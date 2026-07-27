import { describe, expect, it } from 'bun:test';
import { formatMemoryWithBudget } from '../../src/runtime/ContextBudget.js';

/**
 * Working memory is serialised into the system prompt. It iterated `Object.entries` in
 * INSERTION order, so the same logical memory produced different bytes depending on the
 * order keys happened to be written.
 *
 * That is a live risk, not a theoretical one: working memory is persisted, and a store that
 * rebuilds the object — a Redis hash, a Postgres row mapped to an object — can hand back a
 * different key order. Different bytes in the prompt means a different prefix, which means
 * a cache miss on a conversation that should have hit.
 */
describe('working-memory serialisation', () => {
  it('is byte-identical regardless of key insertion order', () => {
    const a: Record<string, unknown> = {};
    a.unit = 'A-101';
    a.resident = 'Dana';
    a.urgency = 'emergency';

    const b: Record<string, unknown> = {};
    b.urgency = 'emergency';   // same data, rebuilt in a different order
    b.unit = 'A-101';
    b.resident = 'Dana';

    expect(formatMemoryWithBudget(b, 4_000)).toBe(formatMemoryWithBudget(a, 4_000));
  });

  it('still honours the allowlist', () => {
    const mem = { keep: 'yes', drop: 'no' };
    const out = formatMemoryWithBudget(mem, 4_000, ['keep']);
    expect(out).toContain('keep');
    expect(out).not.toContain('drop');
  });
});
