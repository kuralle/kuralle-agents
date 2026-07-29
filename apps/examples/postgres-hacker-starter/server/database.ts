import { createOpenAI } from '@ai-sdk/openai';
import type {
  KnowledgeProviderConfig,
  KnowledgeRetrievalResult,
  MemoryEntry,
  MemoryService,
  SearchMemoryRequest,
  SearchMemoryResponse,
  Session,
} from '@kuralle-agents/core';
import { embed } from 'ai';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Pool, type PoolClient, type QueryResult } from 'pg';
import { requireServerEnv } from './env';

export interface Profile {
  id: string;
  name: string | null;
  email: string | null;
  preferences: Record<string, string>;
  lastSeenAt: string;
}

export interface MemoryRecord {
  memoryType: string;
  content: string;
  updatedAt: string;
}

export interface OrderRecord {
  orderId: string;
  items: string[];
  total: string;
  status: string;
}

type Queryable = Pick<Pool, 'query'> | Pick<PoolClient, 'query'>;
type EmbedText = (text: string) => Promise<readonly number[]>;

let poolSingleton: Pool | undefined;

export function getPool(): Pool {
  poolSingleton ??= new Pool({
    connectionString: requireServerEnv('DATABASE_URL'),
    max: Number(process.env.PG_POOL_MAX ?? 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    allowExitOnIdle: process.env.NODE_ENV === 'test',
  });
  return poolSingleton;
}

export async function migrateDatabase(client: Queryable = getPool()): Promise<void> {
  const sql = await readFile(resolve(process.cwd(), 'migrations/001_init.sql'), 'utf8');
  await client.query(sql);
}

export function createEmbeddingFunction(): EmbedText {
  const provider = createOpenAI({ apiKey: requireServerEnv('OPENAI_API_KEY') });
  const model = provider.embedding(process.env.OPENAI_EMBEDDING_MODEL?.trim() || 'text-embedding-3-small');
  return async (text) => (await embed({ model, value: text })).embedding;
}

export class HackerRepository {
  constructor(
    private readonly client: Queryable = getPool(),
    private readonly embedText: EmbedText = createEmbeddingFunction(),
  ) {}

  async ensureProfile(userId: string): Promise<Profile> {
    const result = await this.client.query(`
      INSERT INTO profiles (id, last_seen_at) VALUES ($1, NOW())
      ON CONFLICT (id) DO UPDATE SET last_seen_at = NOW()
      RETURNING id, name, email, preferences, last_seen_at
    `, [userId]);
    return profileFromRow(result.rows[0]);
  }

  async getProfile(userId: string): Promise<Profile> {
    const result = await this.client.query(
      'SELECT id, name, email, preferences, last_seen_at FROM profiles WHERE id = $1',
      [userId],
    );
    if (!result.rowCount) return this.ensureProfile(userId);
    return profileFromRow(result.rows[0]);
  }

  async updateProfile(userId: string, field: string, value: string): Promise<Profile> {
    const clean = value.trim();
    if (!clean || clean.length > 320) throw new Error('Profile values must contain 1–320 characters.');
    if (field === 'name' || field === 'email') {
      const result = await this.client.query(`
        UPDATE profiles SET ${field} = $2, updated_at = NOW() WHERE id = $1
        RETURNING id, name, email, preferences, last_seen_at
      `, [userId, clean]);
      if (!result.rowCount) throw new Error('Profile was not found.');
      return profileFromRow(result.rows[0]);
    }
    const preferenceKey = field === 'preferred_language' ? 'language' : field === 'timezone' ? 'timezone' : undefined;
    if (!preferenceKey) throw new Error('Allowed profile fields: name, email, preferred_language, timezone.');
    const result = await this.client.query(`
      UPDATE profiles
      SET preferences = preferences || jsonb_build_object($2::text, $3::text), updated_at = NOW()
      WHERE id = $1 RETURNING id, name, email, preferences, last_seen_at
    `, [userId, preferenceKey, clean]);
    if (!result.rowCount) throw new Error('Profile was not found.');
    return profileFromRow(result.rows[0]);
  }

  async remember(userId: string, memoryType: string, content: string): Promise<MemoryRecord> {
    const normalized = normalizeMemoryType(memoryType);
    const clean = content.trim();
    if (!clean || clean.length > 2000) throw new Error('Memory content must contain 1–2000 characters.');
    let vector: readonly number[] | null = null;
    try {
      vector = await this.embedText(`${normalized}: ${clean}`);
    } catch (error) {
      console.warn('Embedding failed; storing a text-searchable memory without a vector.', error);
    }
    const result = await this.client.query(`
      INSERT INTO memories (user_id, memory_type, content, embedding)
      VALUES ($1, $2, $3, $4::vector)
      ON CONFLICT (user_id, memory_type) DO UPDATE SET
        content = EXCLUDED.content,
        embedding = COALESCE(EXCLUDED.embedding, memories.embedding),
        updated_at = NOW()
      RETURNING memory_type, content, updated_at
    `, [userId, normalized, clean, vector ? vectorLiteral(vector) : null]);
    return memoryFromRow(result.rows[0]);
  }

  async recall(userId: string, memoryType: string): Promise<MemoryRecord | null> {
    const result = await this.client.query(
      'SELECT memory_type, content, updated_at FROM memories WHERE user_id = $1 AND memory_type = $2',
      [userId, normalizeMemoryType(memoryType)],
    );
    return result.rowCount ? memoryFromRow(result.rows[0]) : null;
  }

  async forget(userId: string, memoryType: string): Promise<boolean> {
    const result = await this.client.query(
      'DELETE FROM memories WHERE user_id = $1 AND memory_type = $2',
      [userId, normalizeMemoryType(memoryType)],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async listMemories(userId: string): Promise<MemoryRecord[]> {
    const result = await this.client.query(
      'SELECT memory_type, content, updated_at FROM memories WHERE user_id = $1 ORDER BY updated_at DESC',
      [userId],
    );
    return result.rows.map(memoryFromRow);
  }

  async searchMemories(userId: string, query: string, limit = 5): Promise<Array<MemoryRecord & { score: number }>> {
    const safeLimit = Math.max(1, Math.min(limit, 20));
    let vector: readonly number[] | null = null;
    try {
      vector = await this.embedText(query);
    } catch (error) {
      console.warn('Memory query embedding failed; using Postgres text search only.', error);
    }
    const result = vector
      ? await this.client.query(
          'SELECT memory_type, content, score, NOW() AS updated_at FROM match_memories_hybrid($1::vector, $2, $3, $4)',
          [vectorLiteral(vector), query, userId, safeLimit],
        )
      : await this.client.query(`
          SELECT memory_type, content,
            ts_rank_cd(search_document, websearch_to_tsquery('english', $2))::float AS score,
            updated_at
          FROM memories
          WHERE user_id = $1 AND search_document @@ websearch_to_tsquery('english', $2)
          ORDER BY score DESC, updated_at DESC LIMIT $3
        `, [userId, query, safeLimit]);
    return result.rows.map((row) => ({ ...memoryFromRow(row), score: Number(row.score ?? 0) }));
  }

  async getOrder(orderId: string): Promise<OrderRecord | null> {
    const result = await this.client.query(
      'SELECT order_id, items, total::text, status FROM orders WHERE order_id = $1',
      [orderId.trim()],
    );
    if (!result.rowCount) return null;
    const row = result.rows[0];
    return { orderId: String(row.order_id), items: row.items as string[], total: String(row.total), status: String(row.status) };
  }

  async searchKnowledge(
    query: string,
    options: { limit?: number; queryEmbedding?: readonly number[]; includeEmbeddings?: boolean } = {},
  ): Promise<KnowledgeRetrievalResult[]> {
    const limit = Math.max(1, Math.min(options.limit ?? 3, 10));
    let vector = options.queryEmbedding ?? null;
    try {
      vector ??= await this.embedText(query);
    } catch (error) {
      console.warn('Knowledge query embedding failed; using Postgres text search only.', error);
    }
    const result = vector
      ? await this.client.query(`
          SELECT id, title, content, category, 1 - (embedding <=> $1::vector) AS score,
            CASE WHEN $3 THEN embedding::text ELSE NULL END AS embedding
          FROM knowledge WHERE embedding IS NOT NULL
          ORDER BY embedding <=> $1::vector LIMIT $2
        `, [vectorLiteral(vector), limit, options.includeEmbeddings ?? false])
      : await this.client.query(`
          SELECT id, title, content, category,
            ts_rank_cd(search_document, websearch_to_tsquery('english', $1)) AS score,
            NULL AS embedding
          FROM knowledge WHERE search_document @@ websearch_to_tsquery('english', $1)
          ORDER BY score DESC LIMIT $2
        `, [query, limit]);
    return result.rows.map((row) => ({
      id: String(row.id),
      sourceId: String(row.id),
      text: `${row.title}: ${row.content}`,
      score: Number(row.score ?? 0),
      relevanceScore: Number(row.score ?? 0),
      metadata: { title: String(row.title), category: String(row.category) },
      ...(row.embedding ? { embedding: parseVector(String(row.embedding)) } : {}),
    }));
  }

  async upsertSessionReport(session: Session): Promise<void> {
    if (!session.userId) return;
    const report = {
      conversationId: session.conversationId,
      turnCount: session.messages.filter((message) => message.role === 'user').length,
      currentAgent: session.currentAgent,
      messages: session.messages,
      updatedAt: session.updatedAt,
    };
    await this.client.query(`
      INSERT INTO session_reports (session_id, user_id, report)
      VALUES ($1, $2, $3::jsonb)
      ON CONFLICT (session_id) DO UPDATE SET report = EXCLUDED.report, updated_at = NOW()
    `, [session.id, session.userId, JSON.stringify(report)]);
  }

  async listSessionReports(userId: string): Promise<Array<{ sessionId: string; report: unknown; updatedAt: string }>> {
    const result = await this.client.query(
      'SELECT session_id, report, updated_at FROM session_reports WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 25',
      [userId],
    );
    return result.rows.map((row) => ({ sessionId: String(row.session_id), report: row.report, updatedAt: new Date(row.updated_at).toISOString() }));
  }
}

export class HackerMemoryService implements MemoryService {
  constructor(private readonly repository: HackerRepository) {}

  async addSessionToMemory(session: Session): Promise<void> {
    await this.repository.upsertSessionReport(session);
  }

  async searchMemory(request: SearchMemoryRequest): Promise<SearchMemoryResponse> {
    const profile = await this.repository.getProfile(request.userId);
    const matches = await this.repository.searchMemories(request.userId, request.query, request.limit ?? 8);
    const profileContent = [
      profile.name ? `Name: ${profile.name}.` : '',
      profile.email ? `Email on profile: ${profile.email}.` : '',
      Object.keys(profile.preferences).length > 0 ? `Profile preferences: ${JSON.stringify(profile.preferences)}.` : '',
    ].filter(Boolean).join(' ');
    const memories: MemoryEntry[] = [];
    if (profileContent) memories.push({
      id: `${request.userId}:profile`,
      sessionId: 'profile',
      userId: request.userId,
      content: profileContent,
      author: 'profile',
      createdAt: new Date(profile.lastSeenAt),
      score: 1,
    });
    memories.push(...matches.map((memory, index) => ({
      id: `${request.userId}:${memory.memoryType}`,
      sessionId: 'agentic-memory',
      userId: request.userId,
      content: `${memory.memoryType}: ${memory.content}`,
      author: 'memory',
      createdAt: new Date(memory.updatedAt),
      score: memory.score || 1 / (index + 2),
    })));
    return { memories };
  }

  async deleteMemories(userId: string): Promise<void> {
    const memories = await this.repository.listMemories(userId);
    await Promise.all(memories.map((memory) => this.repository.forget(userId, memory.memoryType)));
  }
}

export function createKnowledgeConfig(repository: HackerRepository, embedText = createEmbeddingFunction()): KnowledgeProviderConfig {
  return {
    retriever: {
      retrieve: (query, options) => repository.searchKnowledge(query, {
        limit: options?.topK,
        queryEmbedding: options?.queryEmbedding,
        includeEmbeddings: options?.includeEmbeddings,
      }),
    },
    embedder: { embed: embedText },
    defaults: { topK: 4, maxOutputTokens: 1200, includeEmbeddings: true },
    cache: { maxEntries: 128, ttlMs: 300_000, similarityThreshold: 0.84 },
    renderCitations: 'footnotes',
  };
}

export function normalizeMemoryType(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!/^[a-z][a-z0-9_]{1,63}$/.test(normalized)) {
    throw new Error('Memory labels must start with a letter and contain 2–64 letters, digits, or underscores.');
  }
  return normalized;
}

function vectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(',')}]`;
}

function parseVector(value: string): number[] {
  return value.slice(1, -1).split(',').filter(Boolean).map(Number);
}

function profileFromRow(row: Record<string, unknown>): Profile {
  return {
    id: String(row.id),
    name: row.name == null ? null : String(row.name),
    email: row.email == null ? null : String(row.email),
    preferences: (row.preferences ?? {}) as Record<string, string>,
    lastSeenAt: new Date(row.last_seen_at as string | Date).toISOString(),
  };
}

function memoryFromRow(row: Record<string, unknown>): MemoryRecord {
  return {
    memoryType: String(row.memory_type),
    content: String(row.content),
    updatedAt: new Date(row.updated_at as string | Date).toISOString(),
  };
}
