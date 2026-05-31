import type {
  MemoryService,
  MemoryEntry,
  MemoryIngestionOptions,
  SearchMemoryRequest,
  SearchMemoryResponse,
  Session,
} from '@kuralle-agents/core';
import type { QueryResult } from 'pg';

type PostgresClient = {
  query: (text: string, params?: unknown[]) => Promise<QueryResult>;
};

export type PostgresMemoryStoreOptions = {
  client: PostgresClient;
  memoryTableName?: string;
  autoMigrate?: boolean;
};

const defaultMemoryTable = 'kuralle_memories';

const normalizeTableName = (tableName?: string): string => {
  const table = tableName ?? defaultMemoryTable;
  if (!/^[a-zA-Z0-9_.]+$/.test(table)) {
    throw new Error(`Invalid table name: ${table}`);
  }
  return table;
};

export class PostgresMemoryService implements MemoryService {
  private client: PostgresClient;
  private table: string;
  private ready: Promise<void>;

  constructor(options: PostgresMemoryStoreOptions) {
    this.client = options.client;
    this.table = normalizeTableName(options.memoryTableName);
    const autoMigrate = options.autoMigrate ?? true;
    this.ready = autoMigrate ? this.init() : Promise.resolve();
  }

  private async init(): Promise<void> {
    await this.client.query(
      `CREATE TABLE IF NOT EXISTS ${this.table} (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        content TEXT NOT NULL,
        author TEXT,
        metadata JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`
    );
    await this.client.query(
      `CREATE INDEX IF NOT EXISTS idx_${this.table}_user_id
       ON ${this.table} (user_id)`
    );
    await this.client.query(
      `CREATE INDEX IF NOT EXISTS idx_${this.table}_session_id
       ON ${this.table} (session_id)`
    );
  }

  async addSessionToMemory(
    session: Session,
    options?: MemoryIngestionOptions,
  ): Promise<void> {
    await this.ready;
    if (!session.userId) return;

    // Idempotency: delete previous memories from this session.
    await this.client.query(
      `DELETE FROM ${this.table} WHERE session_id = $1`,
      [session.id]
    );

    const memories = this.extractMemories(session, options);

    for (const memory of memories) {
      await this.client.query(
        `INSERT INTO ${this.table} (id, session_id, user_id, content, author, metadata, created_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
        [
          memory.id,
          memory.sessionId,
          memory.userId,
          memory.content,
          memory.author ?? null,
          memory.metadata ? JSON.stringify(memory.metadata) : null,
          memory.createdAt,
        ]
      );
    }
  }

  async searchMemory(request: SearchMemoryRequest): Promise<SearchMemoryResponse> {
    await this.ready;
    const { userId, query, limit = 10 } = request;

    // Keyword search using ILIKE. Each query term is matched independently.
    // Score is the count of matched terms divided by total terms.
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);

    if (terms.length === 0) {
      return { memories: [] };
    }

    // Build a scoring expression: SUM of CASE WHEN content ILIKE '%term%' THEN 1 ELSE 0 END
    const scoreParts: string[] = [];
    const params: unknown[] = [userId];
    let paramIndex = 2;

    for (const term of terms) {
      scoreParts.push(
        `CASE WHEN content ILIKE $${paramIndex} THEN 1 ELSE 0 END`
      );
      params.push(`%${term}%`);
      paramIndex++;
    }

    const scoreExpr = `(${scoreParts.join(' + ')})::float / ${terms.length}`;
    params.push(limit);

    const result = await this.client.query(
      `SELECT id, session_id, user_id, content, author, metadata, created_at,
              ${scoreExpr} AS score
       FROM ${this.table}
       WHERE user_id = $1 AND (${scoreParts.map((_, i) => `content ILIKE $${i + 2}`).join(' OR ')})
       ORDER BY score DESC, created_at DESC
       LIMIT $${paramIndex}`,
      params
    );

    const memories: MemoryEntry[] = result.rows.map((row: Record<string, unknown>) => ({
      id: row.id as string,
      sessionId: row.session_id as string,
      userId: row.user_id as string,
      content: row.content as string,
      author: row.author as string | undefined,
      metadata: row.metadata as Record<string, unknown> | undefined,
      createdAt: new Date(row.created_at as string),
      score: parseFloat(row.score as string),
    }));

    return { memories };
  }

  async deleteMemories(userId: string): Promise<void> {
    await this.ready;
    await this.client.query(
      `DELETE FROM ${this.table} WHERE user_id = $1`,
      [userId]
    );
  }

  /**
   * Extracts MemoryEntry objects from session messages.
   * Identical logic to InMemoryMemoryService and RedisMemoryService.
   * This duplication is intentional -- each store package must be independently
   * importable without cross-package dependencies beyond @kuralle-agents/core.
   */
  private extractMemories(
    session: Session,
    options?: MemoryIngestionOptions,
  ): MemoryEntry[] {
    const memories: MemoryEntry[] = [];
    const now = new Date();

    for (const message of session.messages) {
      if (message.role !== 'user' && message.role !== 'assistant') continue;

      const content = typeof message.content === 'string'
        ? message.content
        : Array.isArray(message.content)
          ? (message.content as Array<Record<string, unknown>>)
              .filter((p) => p.type === 'text')
              .map((p) => p.text as string)
              .join('\n')
          : '';

      if (!content.trim()) continue;

      memories.push({
        id: `${session.id}:${memories.length}`,
        sessionId: session.id,
        userId: session.userId!,
        content,
        author: message.role,
        metadata: options?.metadata,
        createdAt: now,
      });
    }

    return memories;
  }
}
