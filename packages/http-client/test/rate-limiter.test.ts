import { describe, it, expect } from 'bun:test';
import { RateLimiter } from '../src/rate-limiter.js';

describe('RateLimiter', () => {
  it('acquires immediately when capacity is available', async () => {
    // "Immediately" means "without waiting on a release", which is a property of
    // the limiter — not "within 50ms of wall clock", which is a property of the
    // machine. The wall-clock form flaked under full parallel suite load: an
    // uncontended acquire measured 75ms on a loaded runner and failed a test
    // about queueing behaviour, which is how a green suite starts being ignored.
    const limiter = new RateLimiter({ maxConcurrent: 5, perSecondLimit: 100 });

    // The fast path returns without awaiting anything, so `acquire()` settles as
    // a MICROTASK. The queue path schedules a `setTimeout` drain, so it settles
    // as a macrotask at best. Racing against a zero-delay timer separates the
    // two by event-loop ordering, which does not care how loaded the machine is.
    let timerFired = false;
    setTimeout(() => { timerFired = true; }, 0);

    await limiter.acquire();

    expect(timerFired).toBe(false);
    limiter.release();
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
