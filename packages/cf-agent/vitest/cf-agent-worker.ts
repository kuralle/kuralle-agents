import { DurableObject } from 'cloudflare:workers';
import type { ChannelDriver, HarnessConfig, ScheduledJob } from '@kuralle-agents/core';
import {
  LogConflictError,
  RunNotTerminalError,
  StaleWriteError,
  type DeleteRunOptions,
  type RunFilter,
  type RunState,
  type StepFinalizePatch,
  type StepRecord,
} from '@kuralle-agents/core';
import { SqlPersistentMemoryStore } from '../src/SqlPersistentMemoryStore.js';
import { createSqlExecutor } from '../src/sqlExecutor.js';
import { KuralleAgent } from '../src/KuralleAgent.js';
import { SqlTraceStore } from '../src/SqlTraceStore.js';
import { SqlRunStore } from '../src/SqlRunStore.js';
import { OtelTraceSink } from '@kuralle-agents/core';
import type { LanguageModel } from 'ai';

type RunStoreOp =
  | { op: 'appendStep'; runId: string; record: StepRecord }
  | { op: 'finalizeStep'; runId: string; key: string; patch: StepFinalizePatch }
  | { op: 'getSteps'; runId: string }
  | { op: 'getRunState'; runId: string }
  | { op: 'putRunState'; state: RunState }
  | { op: 'initRun'; state: RunState }
  | { op: 'pruneStepsBeforeEpoch'; runId: string; keepEpoch: number }
  | { op: 'reserveSteps'; runId: string; count: number }
  | { op: 'listRuns'; filter: RunFilter }
  | { op: 'deleteRun'; runId: string; options?: DeleteRunOptions };

function reviveFilter(filter: RunFilter): RunFilter {
  if (filter.deadlineBefore == null) return filter;
  return { ...filter, deadlineBefore: new Date(filter.deadlineBefore) };
}

function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof LogConflictError) {
    return {
      name: error.name,
      message: error.message,
      runId: error.runId,
      expectedIndex: error.expectedIndex,
      actualIndex: error.actualIndex,
    };
  }
  if (error instanceof RunNotTerminalError) {
    return { name: error.name, message: error.message, runId: error.runId, status: error.status };
  }
  if (error instanceof StaleWriteError) {
    return {
      name: error.name,
      message: error.message,
      sessionId: error.sessionId,
      expectedVersion: error.expectedVersion,
      actualVersion: error.actualVersion,
    };
  }
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return { name: 'Error', message: String(error) };
}

async function dispatchRunStore(sql: ReturnType<typeof createSqlExecutor>, request: Request): Promise<Response> {
  const store = new SqlRunStore(sql);
  const body = (await request.json()) as RunStoreOp;
  try {
    switch (body.op) {
      case 'appendStep':
        await store.appendStep(body.runId, body.record);
        return Response.json({ ok: true, result: null });
      case 'finalizeStep':
        await store.finalizeStep(body.runId, body.key, body.patch);
        return Response.json({ ok: true, result: null });
      case 'getSteps':
        return Response.json({ ok: true, result: await store.getSteps(body.runId) });
      case 'getRunState':
        return Response.json({ ok: true, result: await store.getRunState(body.runId) });
      case 'putRunState':
        await store.putRunState(body.state);
        return Response.json({ ok: true, result: body.state });
      case 'initRun':
        await store.initRun(body.state);
        return Response.json({ ok: true, result: body.state });
      case 'pruneStepsBeforeEpoch':
        await store.pruneStepsBeforeEpoch(body.runId, body.keepEpoch);
        return Response.json({ ok: true, result: null });
      case 'reserveSteps':
        return Response.json({ ok: true, result: await store.reserveSteps(body.runId, body.count) });
      case 'listRuns': {
        const refs = [];
        for await (const ref of store.listRuns(reviveFilter(body.filter))) {
          refs.push(ref);
        }
        return Response.json({ ok: true, result: refs });
      }
      case 'deleteRun':
        await store.deleteRun(body.runId, body.options);
        return Response.json({ ok: true, result: null });
      default:
        return Response.json({ ok: false, error: { name: 'Error', message: 'unknown op' } }, { status: 400 });
    }
  } catch (error) {
    return Response.json({ ok: false, error: serializeError(error) }, { status: 400 });
  }
}

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
    if (url.pathname === '/run-store') {
      return dispatchRunStore(createSqlExecutor(this.ctx.storage.sql), request);
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
