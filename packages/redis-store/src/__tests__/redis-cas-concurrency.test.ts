/**
 * Opt-in: needs a REAL Redis because the defect class is invisible to the in-memory
 * mock — its `evalScript` double performs the version check inside `set`, which real
 * Redis does not. Keyed on `REDIS_URL`; MUST skip when unset (never hardcode a URL).
 */
import { describe, expect, it } from 'bun:test';
import { createClient, type RedisClientType } from 'redis';
import { StaleWriteError, type Session } from '@kuralle-agents/core';
import { RedisSessionStore, type RedisClientLike } from '../RedisSessionStore.js';

const REDIS_URL = process.env.REDIS_URL;
const CONCURRENT_SAVES = 16;
const RACE_ROUNDS = 10;
const LOSER_TTL_SECONDS = 42;
const WINNER_TTL_SECONDS = 300;

function makeSession(id: string, version?: number): Session {
  const now = new Date();
  return {
    id,
    conversationId: `conv-${id}`,
    channelId: 'web',
    version,
    createdAt: now,
    updatedAt: now,
    messages: [],
    workingMemory: {},
    currentAgent: 'agent-1',
    activeAgentId: 'agent-1',
    metadata: {
      createdAt: now,
      lastActiveAt: now,
      totalTokens: 0,
      totalSteps: 0,
      handoffHistory: [],
    },
    agentStates: {},
    handoffHistory: [],
  };
}

async function connectClients(count: number, url: string): Promise<RedisClientType[]> {
  const clients: RedisClientType[] = [];
  for (let i = 0; i < count; i++) {
    const client = createClient({ url });
    client.on('error', () => {});
    await client.connect();
    clients.push(client);
  }
  return clients;
}

async function disconnectClients(clients: RedisClientType[]): Promise<void> {
  await Promise.all(clients.map(client => client.disconnect()));
}

/**
 * This helper should be `fromNodeRedis`, and is not, because that adapter is broken.
 *
 * `withEvalScript` in `adapters.ts` wraps by spreading — `{ ...client, evalScript }` —
 * and node-redis v4 keeps its commands on the PROTOTYPE. Measured against a live
 * server: the spread yields 22 own-enumerable keys and `get`, `set`, `del`, `eval`,
 * `sAdd` and `sMembers` all come back `undefined`. `evalScript` survives only because
 * it closes over the original client, so a store built that way can run the CAS script
 * and nothing else.
 *
 * So this attaches `evalScript` to the live client instead, keeping the prototype
 * chain intact. It is a workaround, tracked separately as "Fix fromNodeRedis and
 * fromIORedis, which spread away every client command" — when that lands, delete this
 * and call `fromNodeRedis`, which is what a user would actually write.
 */
function asScriptCapableClient(client: RedisClientType): RedisClientLike {
  const like = client as unknown as RedisClientLike;
  like.evalScript = (script, keys, args) => client.eval(script, { keys, arguments: args });
  return like;
}

function createStore(client: RedisClientType, prefix: string, sessionTtlSeconds?: number) {
  return new RedisSessionStore({
    client: asScriptCapableClient(client),
    prefix,
    sessionTtlSeconds,
    enableCleanupIndex: false,
  });
}

describe.skipIf(!REDIS_URL)('RedisSessionStore CAS against real Redis', () => {
  it('N concurrent saves at the same version: one winner, N-1 StaleWriteError, version +1', async () => {
    const url = REDIS_URL!;
    const tablePrefix = `cas_race_${Date.now().toString(36)}`;
    const clients = await connectClients(CONCURRENT_SAVES, url);

    try {
      for (let round = 0; round < RACE_ROUNDS; round++) {
        const sessionId = `session-${tablePrefix}-${round}`;
        const seedStore = createStore(clients[0], tablePrefix);

        await seedStore.save(makeSession(sessionId));

        const baseline = (await seedStore.get(sessionId))!;
        const expectedVersion = baseline.version!;
        expect(expectedVersion).toBe(1);

        const writers = clients.map((client, index) => {
          const store = createStore(client, tablePrefix);
          const session = structuredClone(baseline);
          session.workingMemory = { writer: `client-${index}` };
          return { store, session, writer: `client-${index}` };
        });

        const results = await Promise.allSettled(
          writers.map(({ store, session }) => store.save(session)),
        );

        const fulfilled = results.filter(result => result.status === 'fulfilled');
        const rejected = results.filter(result => result.status === 'rejected');

        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(CONCURRENT_SAVES - 1);
        for (const result of rejected) {
          expect((result as PromiseRejectedResult).reason).toBeInstanceOf(StaleWriteError);
        }

        const final = (await seedStore.get(sessionId))!;
        expect(final.version).toBe(expectedVersion + 1);
        expect(final.version).not.toBe(expectedVersion + CONCURRENT_SAVES);

        const winnerWriter = (final.workingMemory as { writer?: string }).writer;
        expect(writers.some(entry => entry.writer === winnerWriter)).toBe(true);
        expect(final.workingMemory).toEqual({ writer: winnerWriter });
      }
    } finally {
      await disconnectClients(clients);
    }
  }, { timeout: 120_000 });

  it('CAS losing branch does not rewrite the key or its TTL', async () => {
    const url = REDIS_URL!;
    const tablePrefix = `cas_ttl_${Date.now().toString(36)}`;
    const sessionId = `session-${tablePrefix}`;
    const key = `${tablePrefix}:session:${sessionId}`;
    const client = createClient({ url });
    client.on('error', () => {});
    await client.connect();

    try {
      const store = createStore(client, tablePrefix, WINNER_TTL_SECONDS);

      const seeded = makeSession(sessionId);
      await store.save(seeded);
      const stored = (await store.get(sessionId))!;
      expect(stored.version).toBe(1);

      const payload = JSON.stringify({
        ...stored,
        createdAt: stored.createdAt.toISOString(),
        updatedAt: stored.updatedAt.toISOString(),
        metadata: {
          ...stored.metadata!,
          createdAt: stored.metadata!.createdAt.toISOString(),
          lastActiveAt: stored.metadata!.lastActiveAt.toISOString(),
        },
      });
      await client.set(key, payload);
      await client.expire(key, LOSER_TTL_SECONDS);

      const ttlBefore = await client.ttl(key);
      expect(ttlBefore).toBeGreaterThan(0);
      expect(ttlBefore).toBeLessThanOrEqual(LOSER_TTL_SECONDS);

      const staleAttempt = structuredClone(stored);
      staleAttempt.version = 0;
      staleAttempt.workingMemory = { tampered: true };

      await expect(store.save(staleAttempt)).rejects.toBeInstanceOf(StaleWriteError);

      const rawAfter = await client.get(key);
      expect(rawAfter).toBe(payload);

      const ttlAfter = await client.ttl(key);
      expect(ttlAfter).toBeGreaterThan(0);
      expect(ttlAfter).toBeLessThanOrEqual(LOSER_TTL_SECONDS);
      expect(ttlAfter).not.toBe(WINNER_TTL_SECONDS);
    } finally {
      await client.disconnect();
    }
  }, { timeout: 30_000 });
});
