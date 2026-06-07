import { DurableObject } from 'cloudflare:workers';
import { SqlPersistentMemoryStore } from '../src/SqlPersistentMemoryStore.js';
import { createSqlExecutor } from '../src/sqlExecutor.js';

export class TestMemoryDO extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== '/roundtrip') {
      return new Response('not found', { status: 404 });
    }

    const sql = createSqlExecutor(this.ctx.storage.sql);
    const storeA = new SqlPersistentMemoryStore(sql);
    await storeA.saveBlock(
      { key: 'USER', scope: 'user', content: 'workerd-durable', charLimit: 1000 },
      'workerd-owner',
    );

    const storeB = new SqlPersistentMemoryStore(sql);
    const loaded = await storeB.loadBlock('user', 'workerd-owner', 'USER');

    return Response.json({ content: loaded?.content ?? null });
  }
}

export default {
  async fetch() {
    return new Response('ok');
  },
};
