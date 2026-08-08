import { env, evictDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

/**
 * REQ-14 — MCP connections survive a Durable Object eviction and wake with no
 * user-visible reconnect, and nothing non-serialisable or credential-valued was
 * persisted.
 *
 * The eviction here is real: `evictDurableObject` destroys the running instance, so the
 * `/call` request after it is served by a genuinely fresh object that has only storage
 * to work from. A test that merely constructed a second manager against the same storage
 * would prove the rebuild path parses, not that hibernation is survivable.
 */

interface McpHibernationEnv {
  MCP_DO: DurableObjectNamespace;
}

/**
 * The complete set of keys a persisted server row may carry. Declared here, in the test,
 * on purpose: a whitelist maintained next to the implementation drifts with it and stops
 * catching the field somebody adds later. Anything outside this set fails.
 */
const ALLOWED_ROW_KEYS = ['id', 'name', 'type', 'url'] as const;

/** Values the DO is told to use as a credential. Neither may reach storage. */
const SENTINEL_BEARER = 'SENTINEL_BEARER_MUST_NOT_PERSIST';
const SENTINEL_HEADER = 'SENTINEL_HEADER_MUST_NOT_PERSIST';

function stub() {
  const bindings = env as unknown as McpHibernationEnv;
  return bindings.MCP_DO.get(bindings.MCP_DO.idFromName('mcp-hibernation'));
}

async function json<T>(target: ReturnType<typeof stub>, path: string): Promise<T> {
  const response = await target.fetch(`http://do${path}`);
  if (!response.ok) {
    throw new Error(`${path} failed: ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as T;
}

describe('MCP connections survive DO hibernation (REQ-14)', () => {
  it('rebuilds after a real eviction and serves a tool call with no reconnect by the caller', async () => {
    const target = stub();

    const connected = await json<{ tools: string[] }>(target, '/connect');
    expect(connected.tools).toContain('stub__echo');

    // Real eviction — the instance and everything in its memory is destroyed.
    await evictDurableObject(target);

    // The caller does not reconnect. It just calls a tool, exactly as it would have
    // before the eviction; the wake path is the implementation's problem.
    const called = await json<{ result: string }>(target, '/call');
    expect(called.result).toBe('hello-after-wake');
  });

  it('persists only the declared serialisable subset — no functions, no credentials', async () => {
    const target = stub();
    await json(target, '/connect');

    const { rows } = await json<{ rows: Array<Record<string, unknown>> }>(
      target,
      '/rows',
    );

    expect(rows.length).toBeGreaterThan(0);

    for (const row of rows) {
      // Key allowlist: fail on anything outside the declared subset, so a field added
      // later has to be declared here deliberately rather than persisted by accident.
      for (const key of Object.keys(row)) {
        expect(ALLOWED_ROW_KEYS).toContain(key as (typeof ALLOWED_ROW_KEYS)[number]);
      }
      // No value may be a function or otherwise non-serialisable.
      for (const value of Object.values(row)) {
        expect(typeof value).not.toBe('function');
        expect(value).not.toBeInstanceOf(Promise);
      }
    }

    // The blunt instrument, and the one that cannot be argued with: the credential
    // strings the DO actually used must appear nowhere in what was written down.
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain(SENTINEL_BEARER);
    expect(serialized).not.toContain(SENTINEL_HEADER);
  });

  it('writes nothing credential-valued into raw storage either, not just into the row shape', async () => {
    const target = stub();
    await json(target, '/connect');

    // Reads every value out of the DO's own SQLite, not just the rows the store chose
    // to hand back. A store that returned a scrubbed view while writing the token to a
    // column would pass the assertion above and fail this one.
    const { dump } = await json<{ dump: string }>(target, '/raw-storage-dump');

    expect(dump).not.toContain(SENTINEL_BEARER);
    expect(dump).not.toContain(SENTINEL_HEADER);
  });
});
