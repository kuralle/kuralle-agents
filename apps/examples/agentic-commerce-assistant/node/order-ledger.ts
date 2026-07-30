import type { Order, OrderLedger } from '@kuralle-agents/commerce';
import type { Pool } from 'pg';

/** Cross-process order serialization using a transaction-scoped Postgres advisory lock. */
export class PostgresOrderLedger implements OrderLedger {
  constructor(private readonly pool: Pool) {}

  async migrate(): Promise<void> {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS kuralle_order_ledger (
      content_key text PRIMARY KEY,
      payload jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
  }

  async get(contentKey: string): Promise<Order | null> {
    await this.migrate();
    const result = await this.pool.query<{ payload: Order }>(
      'SELECT payload FROM kuralle_order_ledger WHERE content_key = $1',
      [contentKey],
    );
    return result.rows[0]?.payload ?? null;
  }

  async putIfAbsent(contentKey: string, order: Order): Promise<Order> {
    await this.migrate();
    const result = await this.pool.query<{ payload: Order }>(
      `INSERT INTO kuralle_order_ledger (content_key, payload) VALUES ($1, $2::jsonb)
       ON CONFLICT (content_key) DO UPDATE SET content_key = excluded.content_key
       RETURNING payload`,
      [contentKey, JSON.stringify(order)],
    );
    return result.rows[0]?.payload ?? order;
  }

  async runOnce(contentKey: string, create: () => Promise<Order>): Promise<Order> {
    await this.migrate();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [contentKey]);
      const existing = await client.query<{ payload: Order }>(
        'SELECT payload FROM kuralle_order_ledger WHERE content_key = $1',
        [contentKey],
      );
      if (existing.rows[0]) {
        await client.query('COMMIT');
        return existing.rows[0].payload;
      }
      // The downstream effect also uses contentKey, so retry after a process
      // crash is deduplicated by Porulle/Stripe as well as this ledger.
      const order = await create();
      await client.query(
        'INSERT INTO kuralle_order_ledger (content_key, payload) VALUES ($1, $2::jsonb)',
        [contentKey, JSON.stringify(order)],
      );
      await client.query('COMMIT');
      return order;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
