/// <reference types="@cloudflare/workers-types" />

import { DurableObject } from 'cloudflare:workers';
import type { ThreadSummary } from './admin.js';

type SqlLike = {
  exec: (query: string, ...bindings: unknown[]) => { toArray: () => Array<Record<string, unknown>> };
};

/**
 * Singleton DO (`idFromName('global')`) holding the admin inbox index — one row
 * per conversation, upserted by each channel after a turn. The platform can't
 * enumerate Durable Objects, so this registry is what makes "list all chats"
 * possible. Single-writer by design (fine at demo scale; shard by businessId to
 * scale out).
 */
export class ConversationRegistry extends DurableObject {
  private readonly sql: SqlLike;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    this.sql = ctx.storage.sql as unknown as SqlLike;
    this.sql.exec(
      'CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, channel TEXT NOT NULL, customer TEXT NOT NULL, last_text TEXT NOT NULL, last_role TEXT NOT NULL, last_at INTEGER NOT NULL)',
    );
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/upsert') {
      const t = (await request.json()) as ThreadSummary;
      this.sql.exec(
        'INSERT OR REPLACE INTO threads (id, channel, customer, last_text, last_role, last_at) VALUES (?, ?, ?, ?, ?, ?)',
        t.id,
        t.channel,
        t.customer,
        t.lastText.slice(0, 280),
        t.lastRole,
        t.lastAt,
      );
      return new Response('ok');
    }
    if (request.method === 'GET' && url.pathname === '/list') {
      const rows = this.sql
        .exec(
          'SELECT id, channel, customer, last_text, last_role, last_at FROM threads ORDER BY last_at DESC LIMIT 500',
        )
        .toArray();
      const threads: ThreadSummary[] = rows.map((r) => ({
        id: r.id as string,
        channel: r.channel as ThreadSummary['channel'],
        customer: r.customer as string,
        lastText: r.last_text as string,
        lastRole: r.last_role as ThreadSummary['lastRole'],
        lastAt: r.last_at as number,
      }));
      return Response.json({ data: threads });
    }
    return new Response('not found', { status: 404 });
  }
}
