import { DeploymentError } from '@kuralle-agents/deployment';

interface QueryResultLike {
  rows: Array<Record<string, unknown>>;
  rowCount?: number | null;
}

interface PgClientLike {
  query(text: string, params?: unknown[]): Promise<QueryResultLike>;
}

export interface PostgresThreadExecutionCoordinatorOptions {
  client: PgClientLike;
  tableName?: string;
  autoMigrate?: boolean;
  now?: () => number;
}

export interface PostgresThreadExecutionLease {
  renew(): Promise<void>;
  release(): Promise<void>;
}

export class PostgresThreadExecutionCoordinator {
  private readonly client: PgClientLike;
  private readonly table: string;
  private readonly ready: Promise<void>;
  private readonly now: () => number;

  constructor(options: PostgresThreadExecutionCoordinatorOptions) {
    this.client = options.client;
    this.table = options.tableName ?? 'kuralle_thread_execution_leases';
    if (!/^[a-zA-Z][a-zA-Z0-9_.]*$/.test(this.table)) {
      throw new Error(`Invalid thread lease table: ${this.table}`);
    }
    this.now = options.now ?? Date.now;
    this.ready = (options.autoMigrate ?? true) ? this.migrate() : Promise.resolve();
  }

  async acquire(options: {
    tenantId: string;
    threadId: string;
    ownerId: string;
    ttlMs: number;
  }): Promise<PostgresThreadExecutionLease | null> {
    await this.ready;
    if (!Number.isSafeInteger(options.ttlMs) || options.ttlMs < 1_000) {
      throw new DeploymentError('CONFLICT', 'thread lease TTL must be at least 1000ms');
    }
    const expiresAt = new Date(this.now() + options.ttlMs);
    const result = await this.client.query(
      `INSERT INTO ${this.table} (thread_id,tenant_id,owner_id,expires_at)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (tenant_id,thread_id) DO UPDATE SET
         owner_id=EXCLUDED.owner_id, expires_at=EXCLUDED.expires_at
       WHERE ${this.table}.expires_at <= $5
       RETURNING owner_id`,
      [options.threadId, options.tenantId, options.ownerId, expiresAt, new Date(this.now())],
    );
    if (!result.rows[0] || result.rows[0].owner_id !== options.ownerId) return null;
    let released = false;
    return {
      renew: async () => {
        if (released) throw new DeploymentError('CONFLICT', 'thread lease is already released');
        const renewed = await this.client.query(
          `UPDATE ${this.table} SET expires_at=$4
           WHERE thread_id=$1 AND tenant_id=$2 AND owner_id=$3 RETURNING owner_id`,
          [options.threadId, options.tenantId, options.ownerId, new Date(this.now() + options.ttlMs)],
        );
        if (!renewed.rows[0]) throw new DeploymentError('CONFLICT', 'thread lease was lost');
      },
      release: async () => {
        if (released) return;
        released = true;
        await this.client.query(
          `DELETE FROM ${this.table} WHERE thread_id=$1 AND tenant_id=$2 AND owner_id=$3`,
          [options.threadId, options.tenantId, options.ownerId],
        );
      },
    };
  }

  private async migrate(): Promise<void> {
    await this.client.query(
      `CREATE TABLE IF NOT EXISTS ${this.table} (
        tenant_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (tenant_id,thread_id)
      )`,
    );
    await this.client.query(
      `CREATE INDEX IF NOT EXISTS ${this.table.replace(/\./g, '_')}_expiry_idx
       ON ${this.table}(expires_at)`,
    );
  }
}
