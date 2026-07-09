import type { RedisClientLike } from './RedisSessionStore.js';

export const callCommand = async <T>(
  client: RedisClientLike,
  names: Array<keyof RedisClientLike>,
  ...args: unknown[]
): Promise<T> => {
  for (const name of names) {
    const fn = client[name];
    if (typeof fn === 'function') {
      return (await fn.call(client, ...args)) as T;
    }
  }
  throw new Error(`Redis client missing command: ${names.join(', ')}`);
};

export const getMembers = async (client: RedisClientLike, key: string): Promise<string[]> => {
  return (await callCommand<string[]>(client, ['smembers', 'sMembers'], key)) ?? [];
};

export const addMembers = async (client: RedisClientLike, key: string, ...members: string[]): Promise<void> => {
  if (members.length === 0) return;
  await callCommand(client, ['sadd', 'sAdd'], key, ...members);
};

export const removeMembers = async (client: RedisClientLike, key: string, ...members: string[]): Promise<void> => {
  if (members.length === 0) return;
  await callCommand(client, ['srem', 'sRem'], key, ...members);
};

export const setExpiration = async (
  client: RedisClientLike,
  key: string,
  ttlSeconds?: number
): Promise<void> => {
  if (!ttlSeconds) return;
  await callCommand(client, ['expire'], key, ttlSeconds);
};

export const setScore = async (
  client: RedisClientLike,
  key: string,
  score: number,
  member: string
): Promise<void> => {
  if (typeof client.zAdd === 'function') {
    await client.zAdd(key, [{ score, value: member }]);
    return;
  }

  if (typeof client.zadd === 'function') {
    try {
      await client.zadd(key, { score, member });
      return;
    } catch {
      await client.zadd(key, score, member);
      return;
    }
  }

  await callCommand(client, ['zadd', 'zAdd'], key, { score, member });
};

export const removeScore = async (client: RedisClientLike, key: string, member: string): Promise<void> => {
  await callCommand(client, ['zrem', 'zRem'], key, member);
};

export const rangeByScore = async (
  client: RedisClientLike,
  key: string,
  min: number | string,
  max: number | string
): Promise<string[]> => {
  return (await callCommand<string[]>(
    client,
    ['zrangebyscore', 'zRangeByScore'],
    key,
    min,
    max
  )) ?? [];
};

export const removeByScore = async (
  client: RedisClientLike,
  key: string,
  min: number,
  max: number
): Promise<void> => {
  await callCommand(client, ['zremrangebyscore', 'zRemRangeByScore'], key, min, max);
};

export const getMulti = async (client: RedisClientLike, keys: string[]): Promise<Array<string | null>> => {
  if (keys.length === 0) return [];

  if (typeof client.mGet === 'function') {
    const result = (await client.mGet(keys)) as Array<string | null> | null;
    return result ?? [];
  }

  if (typeof client.mget === 'function') {
    const result = (await client.mget(...keys)) as Array<string | null> | null;
    return result ?? [];
  }

  const values: Array<string | null> = [];
  for (const key of keys) {
    const value = (await callCommand<string | null>(client, ['get'], key)) ?? null;
    values.push(value);
  }
  return values;
};
