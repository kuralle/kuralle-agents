import {
  encodeRedisSegment,
  FlowDefinitionConflictError,
  FlowDefinitionNameMismatchError,
  FlowDefinitionNotFoundError,
  matchesFlowDefinitionListFilter,
  reviveFlowDefinitionVersion,
  stampNewFlowDefinitionVersion,
  type CreateVersionOptions,
  type FlowDefinition,
  type FlowDefinitionListFilter,
  type FlowDefinitionVersion,
  type FlowDefinitionsStore,
} from '@kuralle-agents/core';
import type { RedisClientLike } from './RedisSessionStore.js';
import { addMembers, callCommand, getMembers, getMulti } from './redisHelpers.js';

export type RedisFlowDefinitionsStoreOptions = {
  client: RedisClientLike;
  prefix?: string;
};

type StoredVersion = Omit<FlowDefinitionVersion, 'createdAt'> & { createdAt: string };

export class RedisFlowDefinitionsStore implements FlowDefinitionsStore {
  private readonly client: RedisClientLike;
  private readonly prefix: string;

  constructor(options: RedisFlowDefinitionsStoreOptions) {
    this.client = options.client;
    this.prefix = options.prefix ?? 'kuralle';
  }

  private versionKey(versionId: string): string {
    return `${this.prefix}:flowdef:v:${encodeRedisSegment(versionId)}`;
  }

  private digestKey(name: string, digest: string): string {
    return `${this.prefix}:flowdef:digest:${encodeRedisSegment(name)}:${digest}`;
  }

  private nameKey(name: string): string {
    return `${this.prefix}:flowdef:name:${encodeRedisSegment(name)}`;
  }

  private allKey(): string {
    return `${this.prefix}:flowdef:all`;
  }

  async createVersion(
    def: FlowDefinition,
    options?: CreateVersionOptions,
  ): Promise<FlowDefinitionVersion> {
    const row = await stampNewFlowDefinitionVersion(def, options);
    const placed = await setIfNotExists(this.client, this.digestKey(row.name, row.digest), row.versionId);
    if (!placed) {
      throw new FlowDefinitionConflictError(row.name, row.digest);
    }
    const payload = serialize(row);
    const versionPlaced = await setIfNotExists(this.client, this.versionKey(row.versionId), payload);
    if (!versionPlaced) {
      await callCommand(this.client, ['del'], this.digestKey(row.name, row.digest));
      throw new FlowDefinitionConflictError(row.name, row.digest);
    }
    await addMembers(this.client, this.nameKey(row.name), row.versionId);
    await addMembers(this.client, this.allKey(), row.versionId);
    return row;
  }

  async setActive(name: string, versionId: string): Promise<FlowDefinitionVersion> {
    const target = await this.getVersion(versionId);
    if (!target) throw new FlowDefinitionNotFoundError({ versionId });
    if (target.name !== name) {
      throw new FlowDefinitionNameMismatchError(versionId, name, target.name);
    }
    const ids = await getMembers(this.client, this.nameKey(name));
    const rows = await this.readVersions(ids);
    for (const row of rows) {
      row.status = row.versionId === versionId ? 'active' : 'superseded';
      await callCommand(this.client, ['set'], this.versionKey(row.versionId), serialize(row));
    }
    const published = await this.getVersion(versionId);
    if (!published) throw new FlowDefinitionNotFoundError({ versionId });
    return published;
  }

  async getActive(name: string): Promise<FlowDefinitionVersion | null> {
    const ids = await getMembers(this.client, this.nameKey(name));
    const rows = await this.readVersions(ids);
    return rows.find(row => row.status === 'active') ?? null;
  }

  async getVersion(versionId: string): Promise<FlowDefinitionVersion | null> {
    const raw = await callCommand<string | null>(this.client, ['get'], this.versionKey(versionId));
    return raw ? deserialize(raw) : null;
  }

  async list(filter?: FlowDefinitionListFilter): Promise<FlowDefinitionVersion[]> {
    const ids = await getMembers(this.client, this.allKey());
    const all = await this.readVersions(ids);
    return all
      .filter(row => matchesFlowDefinitionListFilter(row, all, filter))
      .sort(compareVersions);
  }

  async archive(name: string): Promise<void> {
    const ids = await getMembers(this.client, this.nameKey(name));
    const rows = await this.readVersions(ids);
    if (rows.length === 0) throw new FlowDefinitionNotFoundError({ name });
    for (const row of rows) {
      row.status = 'archived';
      await callCommand(this.client, ['set'], this.versionKey(row.versionId), serialize(row));
    }
  }

  private async readVersions(ids: string[]): Promise<FlowDefinitionVersion[]> {
    if (ids.length === 0) return [];
    const keys = ids.map(id => this.versionKey(id));
    const raws = await getMulti(this.client, keys);
    return raws.filter((raw): raw is string => raw !== null).map(deserialize);
  }
}

function serialize(row: FlowDefinitionVersion): string {
  const stored: StoredVersion = {
    ...row,
    createdAt: row.createdAt.toISOString(),
  };
  return JSON.stringify(stored);
}

function deserialize(raw: string): FlowDefinitionVersion {
  const parsed = JSON.parse(raw) as StoredVersion;
  return reviveFlowDefinitionVersion(parsed);
}

function compareVersions(a: FlowDefinitionVersion, b: FlowDefinitionVersion): number {
  const byTime = b.createdAt.getTime() - a.createdAt.getTime();
  if (byTime !== 0) return byTime;
  return b.versionId.localeCompare(a.versionId);
}

async function setIfNotExists(client: RedisClientLike, key: string, value: string): Promise<boolean> {
  if (typeof client.set !== 'function') {
    throw new Error('Redis client missing command: set');
  }
  let result: unknown;
  try {
    result = await client.set(key, value, { NX: true });
  } catch {
    result = await client.set(key, value, 'NX');
  }
  return result === 'OK' || result === true;
}
