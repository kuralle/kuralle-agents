import { RedisSessionStore } from './RedisSessionStore.js';
import type { RedisClientLike, RedisStoreOptions } from './RedisSessionStore.js';

export type RedisAdapterOptions = Omit<RedisStoreOptions, 'client'>;

const createStore = (client: RedisClientLike, options?: RedisAdapterOptions) =>
  new RedisSessionStore({ client, ...(options ?? {}) });

export const fromUpstash = (client: RedisClientLike, options?: RedisAdapterOptions) =>
  createStore(client, options);

export const fromNodeRedis = (client: RedisClientLike, options?: RedisAdapterOptions) =>
  createStore(client, options);

export const fromIORedis = (client: RedisClientLike, options?: RedisAdapterOptions) =>
  createStore(client, options);
