/**
 * Fts5KeywordIndex — persistent BM25 keyword index over SQLite FTS5.
 *
 * The durable counterpart to the in-memory `BM25Index`: rows live in
 * SQLite, so on Cloudflare (Durable Object SQLite supports the FTS5
 * module) the keyword tier survives hibernation — a waking DO opens the
 * index with ZERO rebuild instead of re-seeding the whole corpus.
 *
 * Ranking uses FTS5's built-in `bm25()` (lower = better; negated here so
 * higher = better, matching `BM25Index`). Queries are tokenized with the
 * same tokenizer as `BM25Index` and OR-combined, mirroring its
 * sum-over-terms semantics.
 */
import { assertSqlIdentifier, execSql, type SqlExecutor } from '../sql.js';
import { tokenizeKeywords, type BM25Document, type BM25SearchResult } from './BM25Index.js';
import type { KeywordIndex } from './KeywordIndex.js';

export interface Fts5KeywordIndexOptions {
  /**
   * Tagged-template SQL executor. On Cloudflare:
   * `createSqlExecutor(ctx.storage.sql)` from `@kuralle-agents/cf-agent`.
   * On Node/Bun: a thin wrapper over `bun:sqlite` / `better-sqlite3`.
   */
  sql: SqlExecutor;
  /** FTS5 virtual table name. Default: 'kuralle_keyword_index'. */
  tableName?: string;
}

export class Fts5KeywordIndex implements KeywordIndex {
  private readonly sql: SqlExecutor;
  private readonly table: string;

  constructor(options: Fts5KeywordIndexOptions) {
    this.sql = options.sql;
    this.table = assertSqlIdentifier(options.tableName ?? 'kuralle_keyword_index');
    execSql(
      this.sql,
      `CREATE VIRTUAL TABLE IF NOT EXISTS ${this.table} ` +
        `USING fts5(doc_id UNINDEXED, content, tokenize = 'unicode61')`,
    );
  }

  get size(): number {
    const rows = execSql<{ n: number }>(
      this.sql,
      `SELECT count(*) AS n FROM ${this.table}`,
    );
    return rows[0]?.n ?? 0;
  }

  add(documents: BM25Document[]): void {
    for (const doc of documents) {
      execSql(this.sql, `DELETE FROM ${this.table} WHERE doc_id = ?`, [doc.id]);
      execSql(
        this.sql,
        `INSERT INTO ${this.table} (doc_id, content) VALUES (?, ?)`,
        [doc.id, doc.text],
      );
    }
  }

  remove(id: string): boolean {
    const existing = execSql<{ n: number }>(
      this.sql,
      `SELECT count(*) AS n FROM ${this.table} WHERE doc_id = ?`,
      [id],
    );
    if ((existing[0]?.n ?? 0) === 0) return false;
    execSql(this.sql, `DELETE FROM ${this.table} WHERE doc_id = ?`, [id]);
    return true;
  }

  search(query: string, topK = 10): BM25SearchResult[] {
    const terms = tokenizeKeywords(query);
    if (terms.length === 0) return [];
    // Tokens are alphanumeric after tokenization; quoting keeps FTS5 from
    // interpreting them as query syntax.
    const match = terms.map((t) => `"${t}"`).join(' OR ');
    const rows = execSql<{ id: string; score: number }>(
      this.sql,
      `SELECT doc_id AS id, -bm25(${this.table}) AS score FROM ${this.table} ` +
        `WHERE ${this.table} MATCH ? ORDER BY bm25(${this.table}) LIMIT ?`,
      [match, topK],
    );
    return rows.map((r) => ({ id: r.id, score: r.score }));
  }

  clear(): void {
    execSql(this.sql, `DELETE FROM ${this.table}`);
  }
}
