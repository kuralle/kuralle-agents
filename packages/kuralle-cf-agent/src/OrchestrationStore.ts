import type { SqlExecutor, OrchestrationState } from './types.js';

/**
 * Lightweight store for Kuralle orchestration state, keyed by session id.
 *
 * This is NOT a SessionStore. CF owns message persistence via its
 * cf_ai_chat_agent_messages table. This store only tracks the state
 * Kuralle needs for multi-agent orchestration within a specific call /
 * logical session:
 *
 *   - currentAgent: which agent is active
 *   - workingMemory: key-value context injected into prompts
 *   - agentStates: per-agent state (flow node, extraction data, etc.)
 *   - handoffHistory: agent-to-agent transfer log
 *
 * Keyed by `sessionId`, so multiple calls into the same DO get isolated
 * orchestration state (fresh flow node per call, independent handoff history).
 * DO-scoped state that should survive across calls (Gemini resumption handle,
 * long-term memory facts) belongs in `this.state`, not here.
 *
 * Earlier versions used a hardcoded `'default'` sentinel, collapsing every
 * call in a DO into the same row. That was fine for single-call demos but
 * caused cross-call state leaks (flow stuck at `confirm` on the 2nd call).
 */
export class OrchestrationStore {
  private sql: SqlExecutor;
  private initialized = false;

  constructor(sql: SqlExecutor) {
    this.sql = sql;
  }

  private ensureTable(): void {
    if (this.initialized) return;
    this.sql`
      CREATE TABLE IF NOT EXISTS kuralle_orchestration (
        id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `;
    this.initialized = true;
  }

  async get(id: string): Promise<OrchestrationState | null> {
    this.ensureTable();
    const rows = this.sql<{ state: string }>`
      SELECT state FROM kuralle_orchestration WHERE id = ${id}
    `;
    if (!rows || rows.length === 0) return null;
    try {
      return JSON.parse(rows[0].state) as OrchestrationState;
    } catch {
      return null;
    }
  }

  async save(id: string, state: OrchestrationState): Promise<void> {
    this.ensureTable();
    const json = JSON.stringify(state);
    this.sql`
      INSERT INTO kuralle_orchestration (id, state, updated_at)
      VALUES (${id}, ${json}, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        state = excluded.state,
        updated_at = excluded.updated_at
    `;
  }

  async clear(id: string): Promise<void> {
    this.ensureTable();
    this.sql`DELETE FROM kuralle_orchestration WHERE id = ${id}`;
  }

  /**
   * Garbage-collect rows older than `maxAgeMs`. Call from an alarm or on
   * DO wake to keep the table bounded when users don't explicitly end calls.
   */
  async cleanup(maxAgeMs: number): Promise<number> {
    this.ensureTable();
    const cutoffMs = Date.now() - maxAgeMs;
    const cutoffIso = new Date(cutoffMs).toISOString().replace('T', ' ').slice(0, 19);
    const before = this.sql<{ n: number }>`SELECT COUNT(*) as n FROM kuralle_orchestration`;
    const beforeCount = before?.[0]?.n ?? 0;
    this.sql`DELETE FROM kuralle_orchestration WHERE updated_at < ${cutoffIso}`;
    const after = this.sql<{ n: number }>`SELECT COUNT(*) as n FROM kuralle_orchestration`;
    const afterCount = after?.[0]?.n ?? 0;
    return beforeCount - afterCount;
  }
}
