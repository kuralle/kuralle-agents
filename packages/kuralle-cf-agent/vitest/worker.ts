import { DurableObject } from 'cloudflare:workers';
import type { HarnessConfig, ScheduledJob } from '@kuralle-agents/core';
import { SqlPersistentMemoryStore } from '../src/SqlPersistentMemoryStore.js';
import { createSqlExecutor } from '../src/sqlExecutor.js';
import { KuralleAgent } from '../src/KuralleAgent.js';

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

/**
 * Workerd parity DO for the DO-alarm wake scheduler: schedules through the
 * real agents-SDK alarm machinery; the callback records the job instead of
 * running a model turn (no provider in workerd tests).
 */
export class TestWakeAgent extends KuralleAgent {
  protected getAgents(): HarnessConfig['agents'] {
    return [{ id: 'a', instructions: 'test agent' }];
  }

  protected getDefaultAgentId(): string {
    return 'a';
  }

  override async runScheduledKuralleJob(job: ScheduledJob): Promise<void> {
    await this.ctx.storage.put('lastJob', job);
  }

  override async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/schedule-wake') {
      const jobId = await this.scheduleWake(0, {
        reason: 'test-nudge',
        payload: { cartId: 'cart-9' },
      });
      return Response.json({ jobId });
    }
    if (url.pathname === '/last-job') {
      const job = (await this.ctx.storage.get('lastJob')) ?? null;
      return Response.json({ job });
    }
    return super.onRequest(request);
  }
}

export default {
  async fetch() {
    return new Response('ok');
  },
};
