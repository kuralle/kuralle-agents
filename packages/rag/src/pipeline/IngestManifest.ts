/**
 * IngestManifest — persistent record of what an index was built from.
 *
 * Stores two things per index:
 *   1. The embedder identity (model id + dimension) that built the index,
 *      so a different model can never silently query or extend it
 *      ("provider lock").
 *   2. A content hash + chunk-id list per ingested document, so unchanged
 *      documents are skipped on re-ingest and stale chunks of changed
 *      documents are cleaned up ("incremental indexing").
 */
import { assertSqlIdentifier, execSql, type SqlExecutor } from '../sql.js';

export interface IngestManifestDocEntry {
  /** SHA-256 hex of the document text at last ingest. */
  hash: string;
  /** Vector-entry ids written for this document at last ingest. */
  chunkIds: string[];
}

export interface IngestManifestData {
  /** Identity of the embedder that built this index. */
  embedder?: { id?: string; dimension?: number };
  /** Per-document ingest record, keyed by document id. */
  docs: Record<string, IngestManifestDocEntry>;
}

export interface IngestManifest {
  load(indexName: string): Promise<IngestManifestData | undefined>;
  save(indexName: string, data: IngestManifestData): Promise<void>;
}

/** SHA-256 hex via WebCrypto — identical on Node 18+, Bun, and Workers. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Process-lifetime manifest for dev/tests and long-lived Node servers. */
export class InMemoryIngestManifest implements IngestManifest {
  private readonly data = new Map<string, IngestManifestData>();

  async load(indexName: string): Promise<IngestManifestData | undefined> {
    const entry = this.data.get(indexName);
    return entry ? structuredClone(entry) : undefined;
  }

  async save(indexName: string, data: IngestManifestData): Promise<void> {
    this.data.set(indexName, structuredClone(data));
  }
}

export interface SqlIngestManifestOptions {
  /** Tagged-template SQL executor (DO SQLite, bun:sqlite, better-sqlite3). */
  sql: SqlExecutor;
  /** Table name. Default: 'kuralle_rag_manifest'. */
  tableName?: string;
}

/**
 * SQLite-backed manifest. On Cloudflare, pass the Durable Object's
 * `createSqlExecutor(ctx.storage.sql)` from `@kuralle-agents/cf-agent`;
 * the manifest then survives hibernation alongside the session state.
 */
export class SqlIngestManifest implements IngestManifest {
  private readonly sql: SqlExecutor;
  private readonly table: string;

  constructor(options: SqlIngestManifestOptions) {
    this.sql = options.sql;
    this.table = assertSqlIdentifier(options.tableName ?? 'kuralle_rag_manifest');
    execSql(
      this.sql,
      `CREATE TABLE IF NOT EXISTS ${this.table} (index_name TEXT PRIMARY KEY, data TEXT NOT NULL)`,
    );
  }

  async load(indexName: string): Promise<IngestManifestData | undefined> {
    const rows = execSql<{ data: string }>(
      this.sql,
      `SELECT data FROM ${this.table} WHERE index_name = ?`,
      [indexName],
    );
    if (rows.length === 0) return undefined;
    return JSON.parse(rows[0]!.data) as IngestManifestData;
  }

  async save(indexName: string, data: IngestManifestData): Promise<void> {
    execSql(
      this.sql,
      `INSERT INTO ${this.table} (index_name, data) VALUES (?, ?) ` +
        `ON CONFLICT(index_name) DO UPDATE SET data = excluded.data`,
      [indexName, JSON.stringify(data)],
    );
  }
}
