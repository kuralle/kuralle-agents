import { randomUUID } from 'node:crypto';
import type { AuditListOptions, ConversationAuditEntry, Session, SessionStore } from '@kuralle-agents/core';
import {
  callCommand,
  getMembers,
  addMembers,
  removeMembers,
  setExpiration,
  setScore,
  removeScore,
  rangeByScore,
  removeByScore,
} from './redisHelpers.js';

type RedisResult<T = unknown> = T | null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- reason: redis commands have heterogeneous arg signatures; unknown[] would break structural matching with the client's typed methods
type RedisCommand = (...args: any[]) => Promise<RedisResult>;

export type RedisClientLike = {
  get?: RedisCommand;
  set?: RedisCommand;
  del?: RedisCommand;
  mget?: RedisCommand;
  sadd?: RedisCommand;
  srem?: RedisCommand;
  smembers?: RedisCommand;
  expire?: RedisCommand;
  pexpire?: RedisCommand;
  zadd?: RedisCommand;
  zrem?: RedisCommand;
  zrangebyscore?: RedisCommand;
  zremrangebyscore?: RedisCommand;
  sAdd?: RedisCommand;
  sRem?: RedisCommand;
  sMembers?: RedisCommand;
  mGet?: RedisCommand;
  pExpire?: RedisCommand;
  zAdd?: RedisCommand;
  zRem?: RedisCommand;
  zRangeByScore?: RedisCommand;
  zRemRangeByScore?: RedisCommand;
  hset?: RedisCommand;
  hSet?: RedisCommand;
  hgetall?: RedisCommand;
  hGetAll?: RedisCommand;
  hget?: RedisCommand;
  hGet?: RedisCommand;
};

export type RedisStoreOptions = {
  client: RedisClientLike;
  prefix?: string;
  sessionTtlSeconds?: number;
  enableCleanupIndex?: boolean;
};

const defaultPrefix = 'kuralle';

const reviveSession = (raw: Session): Session => {
  const session = { ...raw } as Session;
  session.conversationId = session.conversationId ?? session.id;
  session.channelId = session.channelId ?? 'web';
  session.createdAt = new Date(session.createdAt);
  session.updatedAt = new Date(session.updatedAt);
  session.handoffHistory = (session.handoffHistory ?? []).map(record => ({
    ...record,
    timestamp: new Date(record.timestamp),
  }));
  if (session.metadata) {
    session.metadata = {
      ...session.metadata,
      createdAt: new Date(session.metadata.createdAt),
      lastActiveAt: new Date(session.metadata.lastActiveAt),
      handoffHistory: (session.metadata.handoffHistory ?? []).map(record => ({
        ...record,
        timestamp: new Date(record.timestamp),
      })),
    };
  }
  session.agentStates = Object.fromEntries(
    Object.entries(session.agentStates ?? {}).map(([agentId, state]) => [
      agentId,
      {
        ...state,
        lastActive: new Date(state.lastActive),
      },
    ])
  );
  return session;
};

export class RedisSessionStore implements SessionStore {
  private client: RedisClientLike;
  private prefix: string;
  private sessionTtlSeconds?: number;
  private enableCleanupIndex: boolean;

  constructor(options: RedisStoreOptions) {
    this.client = options.client;
    this.prefix = options.prefix ?? defaultPrefix;
    this.sessionTtlSeconds = options.sessionTtlSeconds;
    this.enableCleanupIndex = options.enableCleanupIndex ?? true;
  }

  private sessionKey(id: string): string {
    return `${this.prefix}:session:${id}`;
  }

  private sessionIndexKey(): string {
    return `${this.prefix}:sessions`;
  }

  private userIndexKey(userId: string): string {
    return `${this.prefix}:user:${userId}:sessions`;
  }

  private conversationIndexKey(conversationId: string): string {
    return `${this.prefix}:conv:${conversationId}`;
  }

  private updatedIndexKey(): string {
    return `${this.prefix}:sessions:updated`;
  }

  private auditKey(id: string): string {
    return `${this.prefix}:audit:${id}`;
  }

  async get(id: string): Promise<Session | null> {
    const raw = await callCommand<unknown>(this.client, ['get'], this.sessionKey(id));

    if (!raw) return null;

    try {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return reviveSession(parsed as Session);
    } catch (error) {
      console.error('Failed to parse session data from Redis', error);
      return null;
    }
  }

  async save(session: Session): Promise<void> {
    const previous = await this.get(session.id);
    session.updatedAt = new Date();
    session.conversationId = session.conversationId ?? session.id;
    session.channelId = session.channelId ?? 'web';
    const key = this.sessionKey(session.id);
    const payload = JSON.stringify(session);

    await callCommand(this.client, ['set'], key, payload);
    await setExpiration(this.client, key, this.sessionTtlSeconds);

    await addMembers(this.client, this.sessionIndexKey(), session.id);

    if (session.userId) {
      await addMembers(this.client, this.userIndexKey(session.userId), session.id);
    }

    if (previous?.conversationId && previous.conversationId !== session.conversationId) {
      await removeMembers(this.client, this.conversationIndexKey(previous.conversationId), session.id);
    }
    await addMembers(this.client, this.conversationIndexKey(session.conversationId), session.id);
    await setExpiration(this.client, this.conversationIndexKey(session.conversationId), this.sessionTtlSeconds);

    if (this.enableCleanupIndex) {
      const score = session.updatedAt.getTime();
      await setScore(this.client, this.updatedIndexKey(), score, session.id);
    }
  }

  async delete(id: string): Promise<void> {
    const session = await this.get(id);
    await callCommand(this.client, ['del'], this.sessionKey(id), this.auditKey(id));
    await removeMembers(this.client, this.sessionIndexKey(), id);

    if (session?.userId) {
      await removeMembers(this.client, this.userIndexKey(session.userId), id);
    }

    if (session?.conversationId) {
      await removeMembers(this.client, this.conversationIndexKey(session.conversationId), id);
    }

    if (this.enableCleanupIndex) {
      await removeScore(this.client, this.updatedIndexKey(), id);
    }
  }

  async list(userId?: string): Promise<Session[]> {
    const indexKey = userId ? this.userIndexKey(userId) : this.sessionIndexKey();
    const ids = await getMembers(this.client, indexKey);
    if (ids.length === 0) return [];

    const keys = ids.map(id => this.sessionKey(id));
    const data = await callCommand<unknown[]>(this.client, ['mget', 'mGet'], keys);
    if (!data || !Array.isArray(data)) return [];

    return data
      .map(raw => {
        if (!raw) return null;
        try {
          const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
          return reviveSession(parsed as Session);
        } catch {
          return null;
        }
      })
      .filter((s): s is Session => s !== null);
  }

  async cleanup(maxAgeMs: number): Promise<number> {
    if (!this.enableCleanupIndex) {
      return 0;
    }

    const cutoff = Date.now() - maxAgeMs;
    const expiredIds = await rangeByScore(this.client, this.updatedIndexKey(), 0, cutoff);
    if (expiredIds.length === 0) return 0;

    for (const id of expiredIds) {
      await this.delete(id);
    }

    await removeByScore(this.client, this.updatedIndexKey(), 0, cutoff);
    return expiredIds.length;
  }

  async appendAuditEntry(sessionId: string, entry: ConversationAuditEntry): Promise<void> {
    const score = Date.parse(entry.at);
    const member = `${Number.isNaN(score) ? Date.now() : score}:${randomUUID()}\t${JSON.stringify(entry)}`;
    await setScore(this.client, this.auditKey(sessionId), Number.isNaN(score) ? Date.now() : score, member);
  }

  async listAuditEntries(sessionId: string, opts: AuditListOptions = {}): Promise<ConversationAuditEntry[]> {
    const min = opts.from?.getTime() ?? '-inf';
    const max = opts.to?.getTime() ?? '+inf';
    const members = await rangeByScore(this.client, this.auditKey(sessionId), min, max);
    const types = opts.types && opts.types.length > 0 ? new Set(opts.types) : undefined;

    return members
      .map(parseAuditMember)
      .filter((entry): entry is ConversationAuditEntry => entry !== null)
      .filter((entry) => !types || types.has(entry.type))
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  }
}

function parseAuditMember(member: string): ConversationAuditEntry | null {
  const sep = member.indexOf('\t');
  const raw = sep >= 0 ? member.slice(sep + 1) : member;
  try {
    return JSON.parse(raw) as ConversationAuditEntry;
  } catch {
    return null;
  }
}
