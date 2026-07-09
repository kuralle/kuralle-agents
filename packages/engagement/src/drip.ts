import type { Session, SessionStore } from '@kuralle-agents/core';
import type {
  OutboundPipeline,
  OutboundTemplate,
  WindowState,
  WindowStore,
} from '@kuralle-agents/messaging';
import type { Scheduler, SendJob } from './scheduler.js';

export const DRIP_WM_KEY = '__dripCampaign';

export interface DripStep {
  template: OutboundTemplate;
  delayMs: number;
}

export interface DripCampaignState {
  id: string;
  step: number;
  stoppedOnReply?: boolean;
}

export interface DripApi {
  scheduleNext(threadId: string, step: DripStep): Promise<string | null>;
  stopOnReply(threadId: string): Promise<void>;
  /** Wire into `createInProcessScheduler({ run: drip.runJob })`. */
  runJob(job: SendJob): Promise<void>;
}

function loadCampaign(session: Session): DripCampaignState | undefined {
  const raw = session.workingMemory[DRIP_WM_KEY];
  if (!raw || typeof raw !== 'object') return undefined;
  return raw as DripCampaignState;
}

async function loadOrCreateSession(
  sessionStore: SessionStore,
  threadId: string,
): Promise<Session> {
  const existing = await sessionStore.get(threadId);
  if (existing) return existing;
  const now = new Date();
  return {
    id: threadId,
    conversationId: threadId,
    channelId: 'api',
    createdAt: now,
    updatedAt: now,
    messages: [],
    workingMemory: {},
    currentAgent: 'main',
    agentStates: {},
    handoffHistory: [],
    metadata: {
      createdAt: now,
      lastActiveAt: now,
      totalTokens: 0,
      totalSteps: 0,
      handoffHistory: [],
    },
  };
}

export function createDrip(opts: {
  scheduler: Scheduler;
  pipeline: OutboundPipeline;
  sessionStore: SessionStore;
  platform: string;
  windowStore?: WindowStore;
}): DripApi {
  async function runJob(job: SendJob): Promise<void> {
    if (job.kind !== 'drip-step') return;
    const threadId = job.payload.threadId;
    const template = job.payload.template;
    if (typeof threadId !== 'string' || !template || typeof template !== 'object') return;

    const session = await opts.sessionStore.get(threadId);
    if (session) {
      const campaign = loadCampaign(session);
      if (campaign?.stoppedOnReply) return;
    }

    const window: WindowState = opts.windowStore
      ? await opts.windowStore.get(threadId)
      : { open: false, expiresAt: null };

    await opts.pipeline.send({
      threadId,
      platform: opts.platform,
      payload: { kind: 'template', template: template as OutboundTemplate },
      meta: {
        window,
        parts: [],
        sessionId: threadId,
        userId:
          typeof job.payload.userId === 'string' ? job.payload.userId : undefined,
      },
    });
  }

  return {
    runJob,

    async scheduleNext(threadId, step) {
      const session = await loadOrCreateSession(opts.sessionStore, threadId);
      const campaign = loadCampaign(session);
      if (campaign?.stoppedOnReply) return null;

      const nextCampaign: DripCampaignState = {
        id: campaign?.id ?? threadId,
        step: (campaign?.step ?? 0) + 1,
        stoppedOnReply: campaign?.stoppedOnReply,
      };
      session.workingMemory[DRIP_WM_KEY] = nextCampaign;
      session.updatedAt = new Date();
      await opts.sessionStore.save(session);

      return opts.scheduler.enqueue(
        {
          kind: 'drip-step',
          payload: {
            threadId,
            template: step.template,
            platform: opts.platform,
          },
        },
        { delayMs: step.delayMs },
      );
    },

    async stopOnReply(threadId) {
      const session = await loadOrCreateSession(opts.sessionStore, threadId);
      const campaign = loadCampaign(session) ?? { id: threadId, step: 0 };
      session.workingMemory[DRIP_WM_KEY] = { ...campaign, stoppedOnReply: true };
      session.updatedAt = new Date();
      await opts.sessionStore.save(session);
    },
  };
}
