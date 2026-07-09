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
import { toLanceDbWhere } from '@kuralle-agents/rag/filters';
import type { Connection, Table } from '@lancedb/lancedb';
import * as lancedb from '@lancedb/lancedb';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface LanceDBVectorStoreOptions {
  /**
   * LanceDB database URI. Can be a local path (e.g., './data/lancedb')
   * or a LanceDB Cloud URI.
   */
  uri: string;
  /**
   * Optional pre-existing LanceDB connection. When provided, `uri` is
   * ignored. Useful for connection pooling or custom configuration.
   */
  connection?: Connection;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** Row shape stored in each LanceDB table. */
type LanceRow = Record<string, unknown> & {
  id: string;
  vector: number[];
  metadata: string; // JSON-serialized
  document: string;
};

// ---------------------------------------------------------------------------
// LanceDBVectorStore
// ---------------------------------------------------------------------------

/**
 * VectorStore implementation backed by LanceDB.
 *
 * LanceDB is an embedded vector database that stores data in the Lance
 * columnar format. It runs in-process on Node.js and Bun — no external
 * server required. Not suitable for edge runtimes (Cloudflare Workers,
 * Vercel Edge) because it requires filesystem access.
 *
 * This package is intended for:
 * - Development and testing with persistent storage
 * - Node.js/Bun production deployments
 * - Ingestion-time indexing pipelines
 *
 * For edge/serverless deployments, use HTTP-based vector stores
 * (e.g., @kuralle-agents/vectorize-store for Cloudflare Vectorize).
 */
export class LanceDBVectorStore implements VectorStoreCore, VectorStoreIndexAdmin {
  private readonly uri: string;
  private providedConnection?: Connection;
  private db?: Connection;
  private tables = new Map<string, Table>();

  /** Tracks dimension and metric per index for describeIndex(). */
  private indexMeta = new Map<string, { dimension: number; metric: string }>();

  constructor(options: LanceDBVectorStoreOptions) {
    this.uri = options.uri;
    this.providedConnection = options.connection;
  }

  // -------------------------------------------------------------------------
  // VectorStore interface
  // -------------------------------------------------------------------------

  async createIndex(params: CreateIndexParams): Promise<void> {
    const db = await this.getDb();
    const tableNames = await db.tableNames();

    if (tableNames.includes(params.indexName)) {
      // Idempotent: index already exists
      const table = await db.openTable(params.indexName);
      this.tables.set(params.indexName, table);
      this.indexMeta.set(params.indexName, {
        dimension: params.dimension,
        metric: params.metric ?? 'cosine',
      });
      return;
    }

    // Create with a dummy row to establish schema, then delete it.
    // LanceDB requires at least one row to create a table.
    const dummyVector = new Array(params.dimension).fill(0);
    const table = await db.createTable(params.indexName, [
      {
        id: '__kuralle_schema_init__',
        vector: dummyVector,
        metadata: '{}',
        document: '',
      } satisfies LanceRow,
    ]);

    // Remove the schema initialization row
    await table.delete("id = '__kuralle_schema_init__'");

    this.tables.set(params.indexName, table);
    this.indexMeta.set(params.indexName, {
      dimension: params.dimension,
      metric: params.metric ?? 'cosine',
    });
  }

  async upsert(indexName: string, entries: VectorEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const table = await this.getTable(indexName);

    // LanceDB's add() appends; for upsert semantics, delete existing IDs first
    const ids = entries.map(e => e.id);
    const filterExpr = ids
      .map(id => `id = '${escapeStr(id)}'`)
      .join(' OR ');

    try {
      await table.delete(filterExpr);
    } catch {
      // Table may be empty or IDs may not exist — safe to ignore
    }

    const rows: LanceRow[] = entries.map(e => ({
      id: e.id,
      vector: Array.from(e.vector),
      metadata: JSON.stringify(e.metadata ?? {}),
      document: e.document ?? '',
    }));

    await table.add(rows);
  }

  async query(
    indexName: string,
    params: VectorQueryParams,
  ): Promise<VectorQueryResult[]> {
    const table = await this.getTable(indexName);
    const topK = params.topK ?? 10;

    let queryBuilder = table
      .search(Array.from(params.queryVector))
      .limit(topK);

    // Apply metadata filter if provided (shared translator from @kuralle-agents/rag/filters)
    if (params.filter) {
      const where = toLanceDbWhere(params.filter);
      if (where) {
        queryBuilder = queryBuilder.where(where);
      }
    }

    const results = await queryBuilder.toArray();

    return results.map(row => {
      const metadata = parseMetadata(row.metadata);
      return {
        id: row.id as string,
        score: row._distance != null ? 1 / (1 + row._distance) : 0,
        metadata,
        document: params.includeDocuments !== false ? (row.document as string) : undefined,
        vector: params.includeVectors ? (row.vector as number[]) : undefined,
      };
    });
  }

  async listIndexes(): Promise<string[]> {
    const db = await this.getDb();
    return db.tableNames();
  }

  async deleteIndex(indexName: string): Promise<void> {
    const db = await this.getDb();
    await db.dropTable(indexName);
    this.tables.delete(indexName);
    this.indexMeta.delete(indexName);
  }

  async deleteVectors(
    indexName: string,
    params: { ids?: string[]; filter?: VectorFilter },
  ): Promise<void> {
    const table = await this.getTable(indexName);

    if (params.ids && params.ids.length > 0) {
      const filterExpr = params.ids
        .map(id => `id = '${escapeStr(id)}'`)
        .join(' OR ');
      await table.delete(filterExpr);
    }

    if (params.filter) {
      const where = toLanceDbWhere(params.filter);
      if (where) {
        await table.delete(where);
      }
    }
  }

  async describeIndex(indexName: string): Promise<IndexStats> {
    const table = await this.getTable(indexName);
    const meta = this.indexMeta.get(indexName);

    const count = await table.countRows();

    return {
      dimension: meta?.dimension ?? 0,
      count,
      metric: (meta?.metric as IndexStats['metric']) ?? 'cosine',
    };
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private async getDb(): Promise<Connection> {
    if (this.db) return this.db;
    if (this.providedConnection) {
      this.db = this.providedConnection;
      return this.db;
    }
    this.db = await lancedb.connect(this.uri);
    return this.db;
  }

  private async getTable(indexName: string): Promise<Table> {
    const cached = this.tables.get(indexName);
    if (cached) return cached;

    const db = await this.getDb();
    const table = await db.openTable(indexName);
    this.tables.set(indexName, table);
    return table;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeStr(s: string): string {
  return s.replace(/'/g, "''");
}

function parseMetadata(raw: unknown): Record<string, unknown> | undefined {
  if (typeof raw !== 'string' || raw === '{}') return undefined;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}
