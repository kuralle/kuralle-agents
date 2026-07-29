import { DurableObject } from 'cloudflare:workers';
import type { ChannelDriver, HarnessConfig, ScheduledJob } from '@kuralle-agents/core';
import { SqlPersistentMemoryStore } from '../src/SqlPersistentMemoryStore.js';
import { createSqlExecutor } from '../src/sqlExecutor.js';
import { KuralleAgent } from '../src/KuralleAgent.js';
import { SqlTraceStore } from '../src/SqlTraceStore.js';
import { OtelTraceSink } from '@kuralle-agents/core';
import type { LanguageModel } from 'ai';

export class TestMemoryDO extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/trace-roundtrip') {
      const store = new SqlTraceStore(createSqlExecutor(this.ctx.storage.sql));
      await store.putSpan({
        traceId: 'workerd-trace', spanId: 'root', name: 'turn', kind: 'turn',
        startTime: 10, endTime: 20, status: 'ok', attributes: { sessionId: 'workerd-session' },
      });
      return Response.json(await store.getTrace('workerd-trace'));
    }
    if (url.pathname === '/otel-smoke') {
      let captured: unknown;
      const sink = new OtelTraceSink({
        endpoint: 'https://collector.invalid',
        fetch: async (_input, init) => {
          captured = JSON.parse(String(init?.body));
          return new Response(null, { status: 200 });
        },
      });
      sink.write({
        traceId: '00112233445566778899aabbccddeeff', spanId: '0011223344556677',
        name: 'turn', kind: 'turn', startTime: 10, endTime: 20,
        status: 'ok', attributes: { sessionId: 'workerd-session' },
      });
      await sink.flush();
      return Response.json(captured);
    }
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

const approvalDriver = (): ChannelDriver => ({
  async runAgentTurn(_node, ctx) {
    const approval = await ctx.approve({
      title: 'Create support case?',
      description: 'Send the reviewed summary to a human support queue.',
    });
    return { text: approval.approved ? 'created' : 'cancelled', toolResults: [] };
  },
  async awaitUser() {
    return { type: 'message' as const, input: '' };
  },
});

/** Regression fixture for the completion-oriented HTTP approval contract. */
export class TestApprovalAgent extends KuralleAgent {
  protected getAgents(): HarnessConfig['agents'] {
    return [{ id: 'support', instructions: 'Request approval.', model: {} as LanguageModel }];
  }

  protected getDefaultAgentId(): string {
    return 'support';
  }

  protected getRuntimeConfig(): Partial<HarnessConfig> {
    return { driver: approvalDriver() };
  }
}

export default {
  async fetch() {
    return new Response('ok');
  },
};
