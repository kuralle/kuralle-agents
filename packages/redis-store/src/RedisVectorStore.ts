import type {
  VectorStoreCore,
  VectorStoreIndexAdmin,
  VectorEntry,
  VectorQueryParams,
  VectorQueryResult,
  CreateIndexParams,
  IndexStats,
  VectorFilter,
} from '@kuralle-agents/rag';
import { toRedisFilter } from '@kuralle-agents/rag/filters';
import type { RedisClientLike } from './RedisSessionStore.js';
import { callCommand } from './redisHelpers.js';

export type RedisVectorStoreOptions = {
  /** Redis client (node-redis, ioredis, or Upstash). Must have Redis Search module. */
  client: RedisClientLike;
  /** Key prefix. Default: 'kuralle:vector'. */
  prefix?: string;
};

// Extend RedisClientLike with Search commands
type RedisFtCommand = (...args: unknown[]) => Promise<unknown>;

type SearchClient = RedisClientLike & {
  ft?: {
    create?: RedisFtCommand;
    search?: RedisFtCommand;
    dropIndex?: RedisFtCommand;
    info?: RedisFtCommand;
    _list?: RedisFtCommand;
  };
  call?: RedisFtCommand;
  sendCommand?: RedisFtCommand;
  hset?: RedisFtCommand;
  hSet?: RedisFtCommand;
  hgetall?: RedisFtCommand;
  hGetAll?: RedisFtCommand;
};

const DEFAULT_PREFIX = 'kuralle:vector';

/**
 * VectorStore implementation backed by Redis with Redis Search module.
 *
 * Key layout:
 *   {prefix}:{indexName}:{id}  -- Hash with vector, metadata, document
 *
 * Uses FT.CREATE for index creation and FT.SEARCH with KNN for queries.
 *
 * Requires: Redis 7+ with Redis Search module, or Redis Stack.
 */
export class RedisVectorStore implements VectorStoreCore, VectorStoreIndexAdmin {
  private readonly client: SearchClient;
  private readonly prefix: string;

  constructor(options: RedisVectorStoreOptions) {
    this.client = options.client as SearchClient;
    this.prefix = options.prefix ?? DEFAULT_PREFIX;
  }

  private keyPrefix(indexName: string): string {
    return `${this.prefix}:${indexName}`;
  }

  private hashKey(indexName: string, id: string): string {
    return `${this.keyPrefix(indexName)}:${id}`;
  }

  private ftIndexName(indexName: string): string {
    return `${this.prefix}:${indexName}:idx`;
  }

  private registryKey(): string {
    return `${this.prefix}:_registry`;
  }

  async createIndex(params: CreateIndexParams): Promise<void> {
    const ftIdx = this.ftIndexName(params.indexName);
    const keyPfx = `${this.keyPrefix(params.indexName)}:`;
    const metric = (params.metric ?? 'cosine').toUpperCase();
    const dim = params.dimension;

    // Try to create the FT index
    const ftArgs = [
      ftIdx,
      'ON', 'HASH',
      'PREFIX', '1', keyPfx,
      'SCHEMA',
      'vector', 'VECTOR', 'HNSW', '6',
        'TYPE', 'FLOAT32',
        'DIM', String(dim),
        'DISTANCE_METRIC', metric,
      'document', 'TEXT',
      'metadata', 'TEXT',
    ];

    try {
      await this.rawCommand('FT.CREATE', ...ftArgs);
    } catch (e: unknown) {
      // Index already exists -- idempotent
      const message = e instanceof Error ? e.message : String(e);
      if (message.includes('Index already exists')) return;
      throw e;
    }

    // Store index metadata in registry
    await this.hset(this.registryKey(), params.indexName, JSON.stringify({
      dimension: dim,
      metric: params.metric ?? 'cosine',
    }));
  }

  async upsert(indexName: string, entries: VectorEntry[]): Promise<void> {
    for (const entry of entries) {
      const key = this.hashKey(indexName, entry.id);
      const vectorBuf = float32ArrayToBuffer(entry.vector);
      const metadataStr = entry.metadata ? JSON.stringify(entry.metadata) : '{}';
      const documentStr = entry.document ?? '';

      // node-redis hSet accepts object with Buffer/string values
      if (typeof this.client.hSet === 'function') {
        await this.client.hSet(key, {
          vector: vectorBuf,
          metadata: metadataStr,
          document: documentStr,
          id: entry.id,
        });
      } else if (typeof this.client.hset === 'function') {
        // ioredis: hset(key, field, val, field, val, ...)
        await this.client.hset(
          key,
          'id', entry.id,
          'metadata', metadataStr,
          'document', documentStr,
          'vector', vectorBuf,
        );
      } else {
        throw new Error('Redis client missing hset/hSet command');
      }
    }
  }

  async query(
    indexName: string,
    params: VectorQueryParams,
  ): Promise<VectorQueryResult[]> {
    const ftIdx = this.ftIndexName(indexName);
    const topK = params.topK ?? 10;
    const vectorBuf = float32ArrayToBuffer(params.queryVector);

    // Build filter query (shared translator from @kuralle-agents/rag/filters)
    const filterExpr = toRedisFilter(params.filter);

    // FT.SEARCH idx "(@filter_expr)=>[KNN topK @vector $BLOB AS dist]" PARAMS 2 BLOB <bytes> DIALECT 2
    const searchQuery = `(${filterExpr})=>[KNN ${topK} @vector $BLOB AS dist]`;

    const returnFields = ['id', 'dist', 'metadata'];
    if (params.includeDocuments !== false) returnFields.push('document');

    const ftArgs = [
      ftIdx,
      searchQuery,
      'PARAMS', '2', 'BLOB', vectorBuf,
      'RETURN', String(returnFields.length), ...returnFields,
      'SORTBY', 'dist',
      'LIMIT', '0', String(topK),
      'DIALECT', '2',
    ];

    const result = await this.rawCommand('FT.SEARCH', ...ftArgs);
    return parseSearchResult(result, params.includeVectors);
  }

  async listIndexes(): Promise<string[]> {
    try {
      const data = await this.hgetall(this.registryKey());
      if (!data) return [];
      if (typeof data === 'object' && !Array.isArray(data)) {
        return Object.keys(data);
      }
      // Array format from some clients: [key, val, key, val, ...]
      if (Array.isArray(data)) {
        const keys: string[] = [];
        for (let i = 0; i < data.length; i += 2) {
          keys.push(String(data[i]));
        }
        return keys;
      }
      return [];
    } catch {
      return [];
    }
  }

  async deleteIndex(indexName: string): Promise<void> {
    const ftIdx = this.ftIndexName(indexName);
    try {
      // DD flag deletes all associated hash keys
      await this.rawCommand('FT.DROPINDEX', ftIdx, 'DD');
    } catch {
      // Index might not exist
    }
    try {
      await this.rawCommand('HDEL', this.registryKey(), indexName);
    } catch {
      // Registry might not exist
    }
  }

  async deleteVectors(
    indexName: string,
    params: { ids?: string[]; filter?: VectorFilter },
  ): Promise<void> {
    if (params.ids?.length) {
      for (const id of params.ids) {
        const key = this.hashKey(indexName, id);
        await callCommand(this.client, ['del'], key);
      }
    }

    if (params.filter) {
      // Query matching vectors then delete them
      const results = await this.query(indexName, {
        queryVector: [], // dummy -- we filter by metadata only
        topK: 10000,
        filter: params.filter,
      }).catch(() => []);

      for (const r of results) {
        const key = this.hashKey(indexName, r.id);
        await callCommand(this.client, ['del'], key);
      }
    }
  }

  async describeIndex(indexName: string): Promise<IndexStats> {
    const regData = await this.hget(this.registryKey(), indexName);
    const meta = regData ? JSON.parse(regData) : { dimension: 0, metric: 'cosine' };

    let count = 0;
    try {
      const info = await this.rawCommand('FT.INFO', this.ftIndexName(indexName));
      // FT.INFO returns flat array: [..., 'num_docs', count, ...]
      if (Array.isArray(info)) {
        const idx = info.indexOf('num_docs');
        if (idx >= 0) count = parseInt(String(info[idx + 1]));
      }
    } catch {
      // Index might not exist
    }

    return {
      dimension: meta.dimension,
      count,
      metric: meta.metric,
    };
  }

  // -- Redis command helpers --

  private async rawCommand(cmd: string, ...args: unknown[]): Promise<unknown> {
    // Try node-redis sendCommand
    if (typeof this.client.sendCommand === 'function') {
      return this.client.sendCommand([cmd, ...args.map(a =>
        Buffer.isBuffer(a) ? a : String(a)
      )]);
    }
    // Try ioredis call
    if (typeof this.client.call === 'function') {
      return this.client.call(cmd, ...args);
    }
    // Try ft sub-object (node-redis v4+)
    if (cmd === 'FT.CREATE' && this.client.ft?.create) {
      return this.client.ft.create(...args);
    }
    if (cmd === 'FT.SEARCH' && this.client.ft?.search) {
      return this.client.ft.search(...args);
    }
    if (cmd === 'FT.DROPINDEX' && this.client.ft?.dropIndex) {
      return this.client.ft.dropIndex(...args);
    }
    if (cmd === 'FT.INFO' && this.client.ft?.info) {
      return this.client.ft.info(...args);
    }
    throw new Error(`Redis client does not support raw command execution. Cannot run ${cmd}.`);
  }

  private async hset(key: string, field: string, value: string): Promise<void> {
    await callCommand(this.client, ['hset', 'hSet'], key, field, value);
  }

  private async hgetall(key: string): Promise<Record<string, string> | null> {
    return callCommand(this.client, ['hgetall', 'hGetAll'], key);
  }

  private async hget(key: string, field: string): Promise<string | null> {
    try {
      return await callCommand(this.client, ['hget', 'hGet'], key, field);
    } catch {
      return null;
    }
  }
}

// -- Helpers --

function float32ArrayToBuffer(vector: readonly number[]): Buffer {
  const buf = Buffer.alloc(vector.length * 4);
  for (let i = 0; i < vector.length; i++) {
    buf.writeFloatLE(vector[i], i * 4);
  }
  return buf;
}

function parseSearchResult(
  result: unknown,
  includeVectors?: boolean,
): VectorQueryResult[] {
  if (!result || !Array.isArray(result)) return [];

  // FT.SEARCH returns: [totalCount, key1, [field, val, ...], key2, [field, val, ...], ...]
  const totalCount = typeof result[0] === 'number' ? result[0] : parseInt(String(result[0]));
  if (totalCount === 0) return [];

  const results: VectorQueryResult[] = [];

  for (let i = 1; i < result.length; i += 2) {
    const fields = result[i + 1];
    if (!Array.isArray(fields)) continue;

    const fieldMap: Record<string, string> = {};
    for (let j = 0; j < fields.length; j += 2) {
      fieldMap[String(fields[j])] = String(fields[j + 1]);
    }

    const dist = fieldMap.dist ? parseFloat(fieldMap.dist) : 0;
    let metadata: Record<string, unknown> | undefined;
    try {
      metadata = fieldMap.metadata ? JSON.parse(fieldMap.metadata) : undefined;
    } catch {
      metadata = undefined;
    }

    results.push({
      id: fieldMap.id ?? String(result[i]).split(':').pop() ?? '',
      score: 1 - dist, // Redis returns distance, we need similarity
      metadata,
      document: fieldMap.document || undefined,
      vector: undefined, // Redis doesn't return vectors in FT.SEARCH by default
    });
  }

  return results;
}

