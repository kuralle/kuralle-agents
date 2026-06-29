// FINDING 4: Durable effect key includes callsite ordinal; shifted ordinal can miss journal and re-execute | anchor src/runtime/durable/idempotency.ts:22, src/runtime/ctx.ts:99-133 | why this proves it
import { describe, expect, it } from 'bun:test';
import { toolEffectKey } from '../../src/runtime/durable/idempotency.js';

describe('F4: callsite ordinal in durable effect key (hash-input evidence)', () => {
  it('identical runId/name/args with different callsite yields different keys', () => {
    const runId = 'run1';
    const name = 'create_order';
    const args = { id: 1 };

    const keyAtCallsite3 = toolEffectKey(runId, '3', name, args);
    const keyAtCallsite7 = toolEffectKey(runId, '7', name, args);

    expect(keyAtCallsite3).not.toBe(keyAtCallsite7);
  });

  it('same callsite yields stable key for identical inputs', () => {
    const key1 = toolEffectKey('run1', '3', 'create_order', { id: 1 });
    const key2 = toolEffectKey('run1', '3', 'create_order', { id: 1 });
    expect(key1).toBe(key2);
  });
});