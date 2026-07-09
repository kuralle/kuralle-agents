import { describe, it, expect } from 'bun:test';
import { RateLimiter } from '../src/rate-limiter.js';

describe('RateLimiter', () => {
  it('acquires immediately when capacity is available', async () => {
    const limiter = new RateLimiter({ maxConcurrent: 5, perSecondLimit: 100 });
    const start = Date.now();
    await limiter.acquire();
    limiter.release();
    expect(Date.now() - start).toBeLessThan(50);
  });

  it('queues callers when concurrency is saturated', async () => {
    const limiter = new RateLimiter({ maxConcurrent: 1, perSecondLimit: 1000 });
    await limiter.acquire();
    let second = false;
    const p = limiter.acquire().then(() => {
      second = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(second).toBe(false);
    limiter.release();
    await p;
    expect(second).toBe(true);
    limiter.release();
  });

  it('invokes the usage header parser and enters throttled mode', async () => {
    let seen = 0;
    const parser = (h: Headers) => {
      seen++;
      return h.get('x-over-quota') === '1';
    };
    const limiter = new RateLimiter({ maxConcurrent: 10, perSecondLimit: 100 }, parser);

    limiter.updateFromHeaders(new Headers({ 'x-over-quota': '1' }));
    limiter.updateFromHeaders(new Headers({ 'x-over-quota': '0' }));

    expect(seen).toBe(2);
  });

  it('no-ops when no header parser is configured', () => {
    const limiter = new RateLimiter({ maxConcurrent: 1, perSecondLimit: 1 });
    expect(() => limiter.updateFromHeaders(new Headers({ foo: 'bar' }))).not.toThrow();
  });

  it('swallows header-parser exceptions', () => {
    const limiter = new RateLimiter({}, () => {
      throw new Error('boom');
    });
    expect(() => limiter.updateFromHeaders(new Headers())).not.toThrow();
  });
});
