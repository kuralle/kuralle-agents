import { RedisSessionStore } from './RedisSessionStore.js';
import type { RedisClientLike, RedisStoreOptions } from './RedisSessionStore.js';

export type RedisAdapterOptions = Omit<RedisStoreOptions, 'client'>;

/**
 * Every Redis client can run a Lua script, but each spells `eval` differently:
 *
 *   ioredis     eval(script, numKeys, ...keys, ...args)
 *   node-redis  eval(script, { keys, arguments })
 *   Upstash     eval(script, keys[], args[])
 *
 * The store needs one shape to express its atomic compare-and-swap, so each adapter
 * supplies the mapping. That is what these adapters are for — before this they were
 * pass-throughs that added nothing.
 */
type EvalShape = (
  client: RedisClientLike,
  script: string,
  keys: string[],
  args: string[],
) => Promise<unknown>;

const withEvalScript = (client: RedisClientLike, shape: EvalShape): RedisClientLike => ({
  ...client,
  evalScript: (script, keys, args) => shape(client, script, keys, args),
});

const createStore = (client: RedisClientLike, options?: RedisAdapterOptions) =>
  new RedisSessionStore({ client, ...(options ?? {}) });

/** Upstash REST: `eval(script, keys, args)`. */
export const fromUpstash = (client: RedisClientLike, options?: RedisAdapterOptions) =>
  createStore(
    withEvalScript(client, (c, script, keys, args) =>
      (c as unknown as { eval: (s: string, k: string[], a: string[]) => Promise<unknown> }).eval(
        script,
        keys,
        args,
      ),
    ),
    options,
  );

/** node-redis v4+: `eval(script, { keys, arguments })`. */
export const fromNodeRedis = (client: RedisClientLike, options?: RedisAdapterOptions) =>
  createStore(
    withEvalScript(client, (c, script, keys, args) =>
      (
        c as unknown as {
          eval: (s: string, o: { keys: string[]; arguments: string[] }) => Promise<unknown>;
        }
      ).eval(script, { keys, arguments: args }),
    ),
    options,
  );

/** ioredis: `eval(script, numKeys, ...keys, ...args)`. */
export const fromIORedis = (client: RedisClientLike, options?: RedisAdapterOptions) =>
  createStore(
    withEvalScript(client, (c, script, keys, args) =>
      (c as unknown as { eval: (...a: unknown[]) => Promise<unknown> }).eval(
        script,
        keys.length,
        ...keys,
        ...args,
      ),
    ),
    options,
  );
