import type { QueryResult } from 'pg';
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
import { toSqlWhere } from '@kuralle-agents/rag/filters';

type PostgresClient = {
  query: (text: string, params?: unknown[]) => Promise<QueryResult>;
};

export type PgVectorStoreOptions = {
  /** PostgreSQL client (pg.Pool or pg.Client). Must have pgvector extension installed. */
  client: PostgresClient;
  /** Table name prefix. Each index creates a table named {prefix}_{indexName}. Default: 'kuralle_vectors'. */
  tablePrefix?: string;
};

const DEFAULT_PREFIX = 'kuralle_vectors';
const TABLE_NAME_RE = /^[a-zA-Z0-9_]+$/;

/**
 * VectorStore implementation backed by PostgreSQL with pgvector extension.
 *
 * Each index is a separate table with schema:
 *   id         TEXT PRIMARY KEY
 *   vector     vector(N)
 *   metadata   JSONB
 *   document   TEXT
 *   created_at TIMESTAMPTZ DEFAULT NOW()
 *
 * Requires: PostgreSQL 15+ with pgvector extension.
 *   CREATE EXTENSION IF NOT EXISTS vector;
 */
export class PgVectorStore implements VectorStoreCore, VectorStoreIndexAdmin {
  private readonly client: PostgresClient;
  private readonly prefix: string;
  private initialized = false;

  constructor(options: PgVectorStoreOptions) {
    this.client = options.client;
    this.prefix = options.tablePrefix ?? DEFAULT_PREFIX;
    if (!TABLE_NAME_RE.test(this.prefix)) {
      throw new Error(`Invalid table prefix: "${this.prefix}". Must match ${TABLE_NAME_RE}`);
    }
  }

  private tableName(indexName: string): string {
    if (!TABLE_NAME_RE.test(indexName)) {
      throw new Error(`Invalid index name: "${indexName}". Must match ${TABLE_NAME_RE}`);
    }
    return `${this.prefix}_${indexName}`;
  }

  private async ensureExtension(): Promise<void> {
    if (this.initialized) return;
    await this.client.query('CREATE EXTENSION IF NOT EXISTS vector');
    this.initialized = true;
  }

  async createIndex(params: CreateIndexParams): Promise<void> {
    await this.ensureExtension();
    const table = this.tableName(params.indexName);
    const metric = params.metric ?? 'cosine';

    await this.client.query(`
      CREATE TABLE IF NOT EXISTS ${table} (
        id TEXT PRIMARY KEY,
        vector vector(${params.dimension}),
        metadata JSONB,
        document TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // Create HNSW index for fast ANN search
    const opsClass = metric === 'cosine'
      ? 'vector_cosine_ops'
      : metric === 'dotproduct'
        ? 'vector_ip_ops'
        : 'vector_l2_ops';

    await this.client.query(`
      CREATE INDEX IF NOT EXISTS ${table}_vector_idx
      ON ${table} USING hnsw (vector ${opsClass})
    `);

    // Store index metadata in a registry table
    await this.client.query(`
      CREATE TABLE IF NOT EXISTS ${this.prefix}_registry (
        index_name TEXT PRIMARY KEY,
        dimension INTEGER NOT NULL,
        metric TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await this.client.query(`
      INSERT INTO ${this.prefix}_registry (index_name, dimension, metric)
      VALUES ($1, $2, $3)
      ON CONFLICT (index_name) DO NOTHING
    `, [params.indexName, params.dimension, metric]);
  }

  async upsert(indexName: string, entries: VectorEntry[]): Promise<void> {
    const table = this.tableName(indexName);

    for (const entry of entries) {
      const vectorStr = `[${Array.from(entry.vector).join(',')}]`;
      await this.client.query(`
        INSERT INTO ${table} (id, vector, metadata, document)
        VALUES ($1, $2::vector, $3, $4)
        ON CONFLICT (id) DO UPDATE SET
          vector = EXCLUDED.vector,
          metadata = EXCLUDED.metadata,
          document = EXCLUDED.document
      `, [
        entry.id,
        vectorStr,
        entry.metadata ? JSON.stringify(entry.metadata) : null,
        entry.document ?? null,
      ]);
    }
  }

  async query(
    indexName: string,
    params: VectorQueryParams,
  ): Promise<VectorQueryResult[]> {
    const table = this.tableName(indexName);
    const topK = params.topK ?? 10;
    const vectorStr = `[${Array.from(params.queryVector).join(',')}]`;

    // Determine distance operator based on index metric
    const registry = await this.client.query(
      `SELECT metric FROM ${this.prefix}_registry WHERE index_name = $1`,
      [indexName],
    );
    const metric = registry.rows[0]?.metric ?? 'cosine';

    // pgvector operators: <=> cosine distance, <-> L2 distance, <#> negative inner product
    const distOp = metric === 'cosine' ? '<=>' : metric === 'dotproduct' ? '<#>' : '<->';

    // Build WHERE clause from filter (shared translator from @kuralle-agents/rag/filters)
    const { whereClause, params: filterParams } = toSqlWhere(params.filter, 1);
    const paramOffset = filterParams.length + 1;

    const selectCols = [
      'id',
      `1 - (vector ${distOp} $${paramOffset}::vector) AS score`,
      'metadata',
      params.includeDocuments !== false ? 'document' : 'NULL AS document',
      params.includeVectors ? `vector::text` : 'NULL AS vector_text',
    ].join(', ');

    const sql = `
      SELECT ${selectCols}
      FROM ${table}
      ${whereClause ? `WHERE ${whereClause}` : ''}
      ORDER BY vector ${distOp} $${paramOffset}::vector
      LIMIT $${paramOffset + 1}
    `;

    const result = await this.client.query(sql, [
      ...filterParams,
      vectorStr,
      topK,
    ]);

    return result.rows.map(row => ({
      id: row.id,
      score: parseFloat(row.score),
      metadata: row.metadata ?? undefined,
      document: row.document ?? undefined,
      vector: row.vector_text ? parseVector(row.vector_text) : undefined,
    }));
  }

  async listIndexes(): Promise<string[]> {
    try {
      const result = await this.client.query(
        `SELECT index_name FROM ${this.prefix}_registry ORDER BY index_name`,
      );
      return result.rows.map(r => r.index_name);
    } catch {
      return [];
    }
  }

  async deleteIndex(indexName: string): Promise<void> {
    const table = this.tableName(indexName);
    await this.client.query(`DROP TABLE IF EXISTS ${table}`);
    try {
      await this.client.query(
        `DELETE FROM ${this.prefix}_registry WHERE index_name = $1`,
        [indexName],
      );
    } catch {
      // Registry table might not exist
    }
  }

  async deleteVectors(
    indexName: string,
    params: { ids?: string[]; filter?: VectorFilter },
  ): Promise<void> {
    const table = this.tableName(indexName);

    if (params.ids?.length) {
      const placeholders = params.ids.map((_, i) => `$${i + 1}`).join(', ');
      await this.client.query(
        `DELETE FROM ${table} WHERE id IN (${placeholders})`,
        params.ids,
      );
    }

    if (params.filter) {
      const { whereClause, params: filterParams } = toSqlWhere(params.filter, 1);
      if (whereClause) {
        await this.client.query(
          `DELETE FROM ${table} WHERE ${whereClause}`,
          filterParams,
        );
      }
    }
  }

  async describeIndex(indexName: string): Promise<IndexStats> {
    const table = this.tableName(indexName);

    const registry = await this.client.query(
      `SELECT dimension, metric FROM ${this.prefix}_registry WHERE index_name = $1`,
      [indexName],
    );

    const countResult = await this.client.query(
      `SELECT COUNT(*) as count FROM ${table}`,
    );

    return {
      dimension: parseInt(registry.rows[0]?.dimension ?? '0'),
      count: parseInt(countResult.rows[0]?.count ?? '0'),
      metric: (registry.rows[0]?.metric ?? 'cosine') as 'cosine' | 'euclidean' | 'dotproduct',
    };
  }
}

function parseVector(vectorStr: string): readonly number[] {
  return vectorStr.replace(/[\[\]]/g, '').split(',').map(Number);
}
