import { describe, it, expect } from 'bun:test';
import { MemoryStore } from '@kuralle-agents/core';
import {
  OutboundPipeline,
  windowGuard,
  InMemoryWindowStore,
} from '@kuralle-agents/messaging';
import type { OutboundSink, OutboundTemplate } from '@kuralle-agents/messaging';
import {
  createInProcessScheduler,
  type InjectableTimer,
  type Scheduler,
  type SendJob,
} from '../src/scheduler.js';
import { createDrip, DRIP_WM_KEY } from '../src/drip.js';

const reengagementTemplate: OutboundTemplate = {
  name: 'win_back',
  language: 'en',
};

const followUpTemplate: OutboundTemplate = {
  name: 'follow_up',
  language: 'en',
};

function makeSendResult(threadId: string) {
  return { messageId: 'msg-out', threadId, timestamp: new Date() };
}

function createTemplateRecordingSink(): OutboundSink & {
  sendTemplateCalls: Array<[string, OutboundTemplate]>;
} {
  const sendTemplateCalls: Array<[string, OutboundTemplate]> = [];
  return {
    sendTemplateCalls,
    sendText: async (to) => makeSendResult(to),
    sendInteractive: async (to) => makeSendResult(to),
    sendMedia: async (to) => makeSendResult(to),
    sendTemplate: async (to, t) => {
      sendTemplateCalls.push([to, t]);
      return makeSendResult(to);
    },
  };
}

function createManualTimer(): {
  timer: InjectableTimer;
  fireAll(): void;
  pendingCount(): number;
} {
  const pending = new Map<unknown, () => void>();
  let nextHandle = 0;

  return {
    timer: {
      set(fn, _ms) {
        const handle = ++nextHandle;
        pending.set(handle, fn);
        return handle;
      },
      clear(handle) {
        pending.delete(handle);
      },
    },
    fireAll() {
      for (const fn of pending.values()) {
        fn();
      }
      pending.clear();
    },
    pendingCount() {
      return pending.size;
    },
  };
}

function createTrackingScheduler(): Scheduler & {
  enqueueCalls: Array<{ job: SendJob; delayMs?: number }>;
} {
  const enqueueCalls: Array<{ job: SendJob; delayMs?: number }> = [];
  return {
    enqueueCalls,
    async enqueue(job, options) {
      enqueueCalls.push({ job, delayMs: options?.delayMs });
      return String(enqueueCalls.length);
    },
    async cancel() {},
  };
}

describe('createDrip', () => {
  it('drip_stops_on_reply', async () => {
    const sessionStore = new MemoryStore();
    const sink = createTemplateRecordingSink();
    const pipeline = new OutboundPipeline([windowGuard], sink);
    const scheduler = createTrackingScheduler();
    const drip = createDrip({
      scheduler,
      pipeline,
      sessionStore,
      platform: 'whatsapp',
    });

    const threadId = 'thread-drip-stop';
    await drip.stopOnReply(threadId);

    const jobId = await drip.scheduleNext(threadId, {
      template: reengagementTemplate,
      delayMs: 5,
    });

    expect(jobId).toBeNull();
    expect(scheduler.enqueueCalls).toHaveLength(0);
    expect(sink.sendTemplateCalls).toHaveLength(0);

    const session = await sessionStore.get(threadId);
    expect(session?.workingMemory[DRIP_WM_KEY]).toMatchObject({
      stoppedOnReply: true,
    });
  });

  it('reengagement_reopens_window_and_resumes', async () => {
    const sessionStore = new MemoryStore();
    const windowStore = new InMemoryWindowStore();
    const sink = createTemplateRecordingSink();
    const pipeline = new OutboundPipeline([windowGuard], sink);
    const manual = createManualTimer();
    const threadId = 'thread-reengage';

    let drip!: ReturnType<typeof createDrip>;
    const scheduler = createInProcessScheduler({
      run: (job) => {
        void drip.runJob(job);
      },
      timer: manual.timer,
    });
    drip = createDrip({
      scheduler,
      pipeline,
      sessionStore,
      platform: 'whatsapp',
      windowStore,
    });

    const closed = await windowStore.get(threadId);
    expect(closed.open).toBe(false);

    const firstJobId = await drip.scheduleNext(threadId, {
      template: reengagementTemplate,
      delayMs: 10,
    });
    expect(firstJobId).toBe('1');
    expect(manual.pendingCount()).toBe(1);

    manual.fireAll();
    await Bun.sleep(0);
    expect(sink.sendTemplateCalls).toEqual([[threadId, reengagementTemplate]]);

    const now = new Date();
    await windowStore.recordInbound(threadId, now);
    const reopened = await windowStore.get(threadId);
    expect(reopened.open).toBe(true);
    if (reopened.open) {
      expect(reopened.expiresAt.getTime()).toBeGreaterThan(now.getTime());
    }

    const secondJobId = await drip.scheduleNext(threadId, {
      template: followUpTemplate,
      delayMs: 10,
    });
    expect(secondJobId).toBe('2');
    expect(manual.pendingCount()).toBe(1);

    manual.fireAll();
    await Bun.sleep(0);
    expect(sink.sendTemplateCalls).toEqual([
      [threadId, reengagementTemplate],
      [threadId, followUpTemplate],
    ]);
  });

  it('scheduleNext enqueues with step.delayMs', async () => {
    const sessionStore = new MemoryStore();
    const sink = createTemplateRecordingSink();
    const pipeline = new OutboundPipeline([windowGuard], sink);
    const scheduler = createTrackingScheduler();
    const drip = createDrip({
      scheduler,
      pipeline,
      sessionStore,
      platform: 'whatsapp',
    });

    await drip.scheduleNext('thread-delay', {
      template: reengagementTemplate,
      delayMs: 42,
    });

    expect(scheduler.enqueueCalls).toHaveLength(1);
    expect(scheduler.enqueueCalls[0]?.delayMs).toBe(42);
    expect(scheduler.enqueueCalls[0]?.job).toEqual({
      kind: 'drip-step',
      payload: {
        threadId: 'thread-delay',
        template: reengagementTemplate,
        platform: 'whatsapp',
      },
    });
  });

  it('runJob skips send when stoppedOnReply is set after enqueue', async () => {
    const sessionStore = new MemoryStore();
    const sink = createTemplateRecordingSink();
    const pipeline = new OutboundPipeline([windowGuard], sink);
    const drip = createDrip({
      scheduler: createTrackingScheduler(),
      pipeline,
      sessionStore,
      platform: 'whatsapp',
    });

    const threadId = 'thread-late-stop';
    await drip.scheduleNext(threadId, {
      template: reengagementTemplate,
      delayMs: 0,
    });
    await drip.stopOnReply(threadId);
    await drip.runJob({
      kind: 'drip-step',
      payload: { threadId, template: reengagementTemplate, platform: 'whatsapp' },
    });

    expect(sink.sendTemplateCalls).toHaveLength(0);
  });
});
