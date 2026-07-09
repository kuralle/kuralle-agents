import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { toolEffectKey } from '../src/runtime/durable/idempotency.js';
import { NODE_JOURNAL_KEY } from './journal-key.fixture.js';

describe('test:journal-key-workers', () => {
  it('toolEffectKey matches Node output under workerd', () => {
    const workersKey = toolEffectKey('run-test', '0', 'ping', { msg: 'hi' });
    expect(workersKey).toBe(NODE_JOURNAL_KEY);
    expect(workersKey).toMatch(/^[a-f0-9]{64}$/);
    void env;
  });
});
