import { routeAgentRequest } from 'agents';
import { CommerceAgent } from './agent.js';
import type { CatalogQueueMessage, Env } from './env.js';

export { CommerceAgent };
export { CatalogSyncWorkflow } from './workflows.js';

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/healthz') {
      return json({ ok: true, runtime: 'cloudflare', substrate: 'durable-object' });
    }
    if (url.pathname === '/admin/catalog-sync' && request.method === 'POST') {
      if (!env.ADMIN_TOKEN || request.headers.get('x-admin-token') !== env.ADMIN_TOKEN) {
        return json({ error: 'unauthorized' }, 401);
      }
      const body = (await request.json()) as { documents?: unknown };
      if (!Array.isArray(body.documents) || body.documents.length === 0) {
        return json({ error: 'documents must be a non-empty array' }, 400);
      }
      await env.COMMERCE_EVENTS.send({
        kind: 'catalog.upsert',
        documents: body.documents as Array<{ id: string; data: Record<string, unknown> }>,
      });
      return json({ accepted: true }, 202);
    }

    const agentResponse = await routeAgentRequest(request, env, { cors: true });
    if (agentResponse) return agentResponse;
    return env.ASSETS.fetch(request);
  },

  async queue(batch: MessageBatch<CatalogQueueMessage>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        await env.CATALOG_SYNC_WORKFLOW.create({
          id: `catalog-${message.id}`,
          params: { documents: message.body.documents },
        });
        message.ack();
      } catch {
        message.retry();
      }
    }
  },
} satisfies ExportedHandler<Env, CatalogQueueMessage>;
