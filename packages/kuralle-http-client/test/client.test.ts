import { describe, it, expect } from 'bun:test';
import { HttpClient } from '../src/client.js';
import { DefaultHttpClassifier, HttpError } from '../src/classifier.js';

function makeFetch(responses: Array<Response | Error>) {
  let i = 0;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl = (async (input, init) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    calls.push({ url, init });
    const r = responses[i++];
    if (r instanceof Error) throw r;
    if (!r) throw new Error('no more mocked responses');
    return r;
  }) as typeof fetch;
  return { fetch: impl, calls };
}

describe('HttpClient — happy path', () => {
  it('performs GET with baseUrl, parses JSON', async () => {
    const { fetch, calls } = makeFetch([
      new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }),
    ]);
    const client = new HttpClient({ baseUrl: 'https://api.test/v1', fetchImpl: fetch });

    const out = await client.get<{ ok: boolean }>('hello', { foo: 'bar' });
    expect(out).toEqual({ ok: true });
    expect(calls[0].url).toContain('https://api.test/v1/hello?foo=bar');
    expect(calls[0].init?.method).toBe('GET');
  });

  it('performs POST with JSON body and Content-Type header', async () => {
    const { fetch, calls } = makeFetch([
      new Response(JSON.stringify({ id: 'abc' }), { status: 200 }),
    ]);
    const client = new HttpClient({ baseUrl: 'https://api.test', fetchImpl: fetch });
    const out = await client.post<{ id: string }>('things', { name: 'x' });
    expect(out).toEqual({ id: 'abc' });
    const init = calls[0].init!;
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({ name: 'x' });
  });

  it('performs DELETE with query params and optional JSON body', async () => {
    const { fetch, calls } = makeFetch([
      new Response(JSON.stringify({ deleted: true }), { status: 200 }),
    ]);
    const client = new HttpClient({ baseUrl: 'https://api.test', fetchImpl: fetch });

    const out = await client.delete<{ deleted: boolean }>('items/42', {
      params: { name: 'tpl' },
      body: { fields: ['ice_breakers'] },
    });

    expect(out).toEqual({ deleted: true });
    expect(calls[0].init?.method).toBe('DELETE');
    expect(calls[0].url).toContain('items/42?name=tpl');
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({ fields: ['ice_breakers'] });
  });

  it('applies dynamic default headers on every call', async () => {
    const { fetch, calls } = makeFetch([
      new Response('{}', { status: 200 }),
      new Response('{}', { status: 200 }),
    ]);
    let token = 'T1';
    const client = new HttpClient({
      baseUrl: 'https://api.test',
      defaultHeaders: () => ({ Authorization: `Bearer ${token}` }),
      fetchImpl: fetch,
    });
    await client.get('a');
    token = 'T2';
    await client.get('b');
    const hdrs = (i: number) => calls[i].init?.headers as Record<string, string>;
    expect(hdrs(0).Authorization).toBe('Bearer T1');
    expect(hdrs(1).Authorization).toBe('Bearer T2');
  });
});

describe('HttpClient — classifier + retry', () => {
  it('uses DefaultHttpClassifier when none provided; retries 5xx', async () => {
    const { fetch, calls } = makeFetch([
      new Response('{}', { status: 503 }),
      new Response(JSON.stringify({ ok: 1 }), { status: 200 }),
    ]);
    const client = new HttpClient({
      baseUrl: 'https://api.test',
      retry: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 5 },
      fetchImpl: fetch,
    });
    const out = await client.get<{ ok: number }>('foo');
    expect(out).toEqual({ ok: 1 });
    expect(calls.length).toBe(2);
  });

  it('does NOT retry 400-range non-retryable statuses', async () => {
    const { fetch, calls } = makeFetch([new Response('{}', { status: 404 })]);
    const client = new HttpClient({
      baseUrl: 'https://api.test',
      retry: { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 5 },
      fetchImpl: fetch,
    });
    await expect(client.get('missing')).rejects.toBeInstanceOf(HttpError);
    expect(calls.length).toBe(1);
  });

  it('dispatches a custom classifier plugin', async () => {
    class DomainError extends Error {
      retryable = false;
      constructor(public readonly code: string) {
        super(`domain:${code}`);
      }
    }
    const classifier = {
      classify: (ctx: { status: number; body: unknown }) => {
        const err = new DomainError(String((ctx.body as { code?: string } | null)?.code ?? ctx.status));
        err.retryable = ctx.status >= 500;
        return err;
      },
    };
    const { fetch } = makeFetch([
      new Response(JSON.stringify({ code: 'E_BAD' }), { status: 400 }),
    ]);
    const client = new HttpClient({
      baseUrl: 'https://api.test',
      classifier,
      retry: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 5 },
      fetchImpl: fetch,
    });
    try {
      await client.get('x');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(DomainError);
      expect((err as DomainError).code).toBe('E_BAD');
    }
  });

  it('retries a classifier-flagged retryable error with retryAfterMs', async () => {
    let attempts = 0;
    const classifier = {
      classify: (_ctx: { status: number }) => {
        const err = Object.assign(new Error('rate limited'), { retryable: true, retryAfterMs: 2 });
        return err;
      },
    };
    const { fetch } = makeFetch([
      new Response('{}', { status: 429 }),
      new Response('{}', { status: 429 }),
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    ]);
    const wrapped = (async (...args: Parameters<typeof fetch>) => {
      attempts++;
      return fetch(...args);
    }) as typeof fetch;
    const client = new HttpClient({
      baseUrl: 'https://api.test',
      classifier,
      retry: { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 10 },
      fetchImpl: wrapped,
    });
    const out = await client.get<{ ok: boolean }>('x');
    expect(out).toEqual({ ok: true });
    expect(attempts).toBe(3);
  });
});

describe('DefaultHttpClassifier', () => {
  it('flags 429 as retryable with Retry-After seconds', () => {
    const classifier = new DefaultHttpClassifier();
    const err = classifier.classify({
      status: 429,
      body: { err: 'too many' },
      url: 'https://x/y',
      method: 'GET',
      headers: new Headers({ 'retry-after': '5' }),
    });
    expect(err.retryable).toBe(true);
    expect(err.retryAfterMs).toBe(5_000);
  });

  it('flags 500/503 as retryable without Retry-After', () => {
    const classifier = new DefaultHttpClassifier();
    const err = classifier.classify({
      status: 503,
      body: null,
      url: 'https://x/y',
      method: 'POST',
      headers: new Headers(),
    });
    expect(err.retryable).toBe(true);
    expect(err.retryAfterMs).toBeUndefined();
  });

  it('does NOT flag 4xx (other than 408/425/429) as retryable', () => {
    const classifier = new DefaultHttpClassifier();
    const err = classifier.classify({
      status: 404,
      body: null,
      url: 'https://x/y',
      method: 'GET',
      headers: new Headers(),
    });
    expect(err.retryable).toBe(false);
  });
});
