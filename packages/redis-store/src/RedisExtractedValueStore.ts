import type {
  ExtractedValue,
  ExtractedValueStore,
  MemoryBlockScope,
} from '@kuralle-agents/core';
import type { RedisClientLike } from './RedisSessionStore.js';
import { callCommand } from './redisHelpers.js';

export type RedisExtractedValueStoreOptions = {
  client: RedisClientLike;
  prefix?: string;
};

/** Percent-encode anything outside a conservative filesystem-safe set. Injective. */
function encodeSegment(part: string): string {
  let out = '';
  for (const byte of new TextEncoder().encode(part)) {
    const ch = String.fromCharCode(byte);
    if (/[A-Za-z0-9._-]/.test(ch) && !(ch === '.' && part === '..')) {
      out += ch;
    } else {
      out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    }
  }
  return out === '.' || out === '..' ? out.replace(/\./g, '%2E') : out;
}

export class RedisExtractedValueStore implements ExtractedValueStore {
  private client: RedisClientLike;
  private prefix: string;

  constructor(options: RedisExtractedValueStoreOptions) {
    this.client = options.client;
    this.prefix = options.prefix ?? 'kuralle';
  }

  private valueKey(scope: MemoryBlockScope, owner: string, slug: string): string {
    return `${this.prefix}:ev:${encodeSegment(scope)}:${encodeSegment(owner)}:${encodeSegment(slug)}`;
  }

  async load(
    scope: MemoryBlockScope,
    owner: string,
    slug: string,
  ): Promise<ExtractedValue | null> {
    const raw = await callCommand<string | null>(
      this.client,
      ['get'],
      this.valueKey(scope, owner, slug),
    );
    if (!raw) {
      return null;
    }
    return JSON.parse(raw) as ExtractedValue;
  }

  async save(value: ExtractedValue, owner: string): Promise<void> {
    const redisKey = this.valueKey(value.scope, owner, value.slug);
    await callCommand(this.client, ['set'], redisKey, JSON.stringify(value));
  }

  async delete(scope: MemoryBlockScope, owner: string, slug: string): Promise<void> {
    await callCommand(this.client, ['del'], this.valueKey(scope, owner, slug));
  }
}
