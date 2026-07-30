import type { Order, OrderLedger } from '@kuralle-agents/commerce';
import type { SqlExecutor } from '@kuralle-agents/cf-agent';

type OrderRow = { payload: string };

/** Session-local durable ledger; the DO is the serialization boundary. */
export class SqlOrderLedger implements OrderLedger {
  constructor(private readonly sql: SqlExecutor) {
    this.sql`CREATE TABLE IF NOT EXISTS agentic_commerce_orders (
      content_key TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`;
  }

  async get(contentKey: string): Promise<Order | null> {
    const row = this.sql<OrderRow>`SELECT payload FROM agentic_commerce_orders WHERE content_key = ${contentKey}`[0];
    return row ? (JSON.parse(row.payload) as Order) : null;
  }

  async putIfAbsent(contentKey: string, order: Order): Promise<Order> {
    this.sql`INSERT INTO agentic_commerce_orders (content_key, payload, created_at)
      VALUES (${contentKey}, ${JSON.stringify(order)}, ${Date.now()})
      ON CONFLICT(content_key) DO NOTHING`;
    return (await this.get(contentKey)) ?? order;
  }

  async runOnce(contentKey: string, create: () => Promise<Order>): Promise<Order> {
    const existing = await this.get(contentKey);
    if (existing) return existing;
    // A Durable Object serializes this session's turns. The remote Porulle call
    // still receives contentKey because a crash can happen before this write.
    return this.putIfAbsent(contentKey, await create());
  }
}
