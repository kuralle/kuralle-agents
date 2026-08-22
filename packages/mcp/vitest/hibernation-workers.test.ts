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
 *
 * `toolFingerprints` is admitted deliberately: it is a map of tool name to a digest of that
 * tool's public catalogue metadata (description, input schema, title) — the same class of
 * data as `tools`, and never anything that authenticates to the server. Adding a key here is
 * meant to be a decision, not a formality; if a new field could carry a credential, the
 * answer is to stop persisting it, not to widen this list.
 */
const ALLOWED_ROW_KEYS = ['id', 'name', 'type', 'url', 'tools', 'toolFingerprints'] as const;

/** Values the DO is told to use as a credential. Neither may reach storage. */
const SENTINEL_BEARER = 'SENTINEL_BEARER_MUST_NOT_PERSIST';
const SENTINEL_HEADER = 'SENTINEL_HEADER_MUST_NOT_PERSIST';

interface WakeReport {
  listCallsAtMapReady: number;
  toolsAtMapReady: string[];
  toolsAfterReconcile: string[];
  listCallsAfterReconcile: number;
}

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
      // No value may be a function or otherwise non-serialisable. `tools` is an array of
      // plain catalogue entries, so it is walked rather than skipped.
      for (const value of Object.values(row)) {
        expect(typeof value).not.toBe('function');
        expect(value).not.toBeInstanceOf(Promise);
        for (const nested of Array.isArray(value) ? value : []) {
          for (const inner of Object.values(nested as Record<string, unknown>)) {
            expect(typeof inner).not.toBe('function');
            expect(inner).not.toBeInstanceOf(Promise);
          }
        }
      }
    }

    // The blunt instrument, and the one that cannot be argued with: the credential
    // strings the DO actually used must appear nowhere in what was written down.
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain(SENTINEL_BEARER);
    expect(serialized).not.toContain(SENTINEL_HEADER);
  });

  it('wakes with a tool map and makes no tools/list round trip to get it', async () => {
    const target = stub();
    await json(target, '/catalog?legacy=on');
    await json(target, '/connect');

    await evictDurableObject(target);

    const woken = await json<WakeReport>(target, '/wake');

    // The count is the assertion. "Tools appeared" passes with or without the cache; only
    // a zero here says the map came from storage rather than from the server.
    expect(woken.listCallsAtMapReady).toBe(0);
    expect(woken.toolsAtMapReady).toContain('stub__echo');
    expect(woken.toolsAtMapReady).toContain('stub__legacy');

    // Background reconciliation still happens — the cache is a head start, not a promise
    // that the catalogue was never checked.
    expect(woken.listCallsAfterReconcile).toBe(1);
  });

  it('converges on the server catalogue when the cached listing has gone stale', async () => {
    const target = stub();
    await json(target, '/catalog?legacy=on');
    await json(target, '/connect');

    // The server drops a tool while the Durable Object is asleep.
    await json(target, '/catalog?legacy=off');
    await evictDurableObject(target);

    const woken = await json<WakeReport>(target, '/wake');

    expect(woken.toolsAtMapReady).toContain('stub__legacy');
    expect(woken.toolsAfterReconcile).not.toContain('stub__legacy');
    expect(woken.toolsAfterReconcile).toContain('stub__echo');
  });

  it('refuses a withdrawn cached tool with a message the model can act on', async () => {
    const target = stub();
    await json(target, '/catalog?legacy=on');
    await json(target, '/connect');

    await json(target, '/catalog?legacy=off');
    await evictDurableObject(target);

    const { error } = await json<{ error: string | null }>(
      target,
      '/call-withdrawn',
    );

    // A turn that started before reconciliation still holds the tool. It must fail as a
    // readable tool error, never as an unhandled rejection or a raw transport fault.
    expect(error).toBeTruthy();
    expect(error).toContain('stub__legacy');
    expect(error).toContain('no longer published');
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
