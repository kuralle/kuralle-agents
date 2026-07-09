import { describe, it, expect } from 'bun:test';
import { RetryQueue, isRetryableError } from '../src/retry.js';

class RetryableTestError extends Error {
  retryable = true;
  retryAfterMs?: number;
  constructor(msg: string, retryAfterMs?: number) {
    super(msg);
    this.name = 'RetryableTestError';
    this.retryAfterMs = retryAfterMs;
  }
}

class PermanentTestError extends Error {
  retryable = false;
  constructor(msg: string) {
    super(msg);
    this.name = 'PermanentTestError';
  }
}

describe('RetryQueue', () => {
  it('returns value without retry on success', async () => {
    const q = new RetryQueue({ maxRetries: 3, baseDelayMs: 1, maxDelayMs: 10 });
    let calls = 0;
    const out = await q.execute(async () => {
      calls++;
      return 42;
    });
    expect(out).toBe(42);
    expect(calls).toBe(1);
  });

  it('retries transient retryable errors until success', async () => {
    const q = new RetryQueue({ maxRetries: 3, baseDelayMs: 1, maxDelayMs: 5 });
    let calls = 0;
    const out = await q.execute(async () => {
      calls++;
      if (calls < 3) throw new RetryableTestError('transient');
      return 'ok';
    });
    expect(out).toBe('ok');
    expect(calls).toBe(3);
  });

  it('throws immediately on non-retryable errors', async () => {
    const q = new RetryQueue({ maxRetries: 3, baseDelayMs: 1, maxDelayMs: 5 });
    let calls = 0;
    await expect(
      q.execute(async () => {
        calls++;
        throw new PermanentTestError('no retry');
      }),
    ).rejects.toThrow('no retry');
    expect(calls).toBe(1);
  });

  it('throws last error after exhausting maxRetries', async () => {
    const q = new RetryQueue({ maxRetries: 2, baseDelayMs: 1, maxDelayMs: 5 });
    let calls = 0;
    await expect(
      q.execute(async () => {
        calls++;
        throw new RetryableTestError(`fail-${calls}`);
      }),
    ).rejects.toThrow('fail-3');
    expect(calls).toBe(3);
  });

  it('retries TypeError (network-level fetch failure)', async () => {
    const q = new RetryQueue({ maxRetries: 1, baseDelayMs: 1, maxDelayMs: 5 });
    let calls = 0;
    const out = await q.execute(async () => {
      calls++;
      if (calls === 1) throw new TypeError('DNS failed');
      return 'ok';
    });
    expect(out).toBe('ok');
    expect(calls).toBe(2);
  });

  it('honors retryAfterMs upper bound via maxDelayMs', async () => {
    const q = new RetryQueue({ maxRetries: 1, baseDelayMs: 1, maxDelayMs: 20 });
    const start = Date.now();
    let calls = 0;
    await q.execute(async () => {
      calls++;
      if (calls === 1) throw new RetryableTestError('slow', 10);
      return 'ok';
    });
    const elapsed = Date.now() - start;
    expect(calls).toBe(2);
    expect(elapsed).toBeGreaterThanOrEqual(0);
    expect(elapsed).toBeLessThan(200);
  });
});

describe('isRetryableError', () => {
  it('recognizes errors with retryable flag', () => {
    expect(isRetryableError(new RetryableTestError('x'))).toBe(true);
    expect(isRetryableError(new PermanentTestError('x'))).toBe(true); // has flag set to false
  });

  it('rejects plain Errors and non-Error values', () => {
    expect(isRetryableError(new Error('x'))).toBe(false);
    expect(isRetryableError('oops')).toBe(false);
    expect(isRetryableError(null)).toBe(false);
  });
});
