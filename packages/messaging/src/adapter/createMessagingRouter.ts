import { Hono } from 'hono';
import type { HarnessStreamPart, Session } from '@kuralle-agents/core';
import type { MessagingRouterConfig, ErrorContext } from '../types.js';
import type { InboundMessage, ReactionData, StatusUpdate } from '../types/messages.js';
import type { OutboundMiddleware } from '../types/outbound.js';
import { InMemoryWindowStore, type WindowStore } from './window-store.js';
import { defaultSessionResolver } from './session-resolver.js';
import {
  InboundResolverChain,
  defaultInboundChain,
} from './input-resolver-chain.js';
import { createInputCoalescer } from './input-coalescer.js';
import { StreamMapper } from './stream-mapper.js';
import { OutboundPipeline } from './outbound-pipeline.js';
import { windowGuard } from './middleware/window-guard.js';
import {
  InMemoryInboundLedger,
  conversationKeyToString,
  type ConversationKey,
} from '../inbound/ledger.js';
import {
  claimAndAppend,
  coalesceMessages,
  consentStop,
  createInboundPipeline,
  ownershipGate,
  recordWindow,
  resolveAndAttachMedia,
  runTurn,
  statusReactionErrorPhase,
  type CoalescedPipelineItem,
} from '../inbound/pipeline.js';
import { noopCoalesceScheduler, PlatformMediaResolver, systemClock } from '../inbound/ports.js';
import type {
  InboundContext,
  InboundEvent,
  InboundRuntime,
  OutboundSender,
  TurnResult,
  TurnRunner,
} from '../inbound/types.js';

function buildOutboundChain(extra?: OutboundMiddleware[]): OutboundMiddleware[] {
  return [...(extra ?? []), windowGuard];
}

function emptySession(sessionId: string, userId?: string): Session {
  const now = new Date();
  return {
    id: sessionId,
    conversationId: sessionId,
    channelId: 'api',
    userId,
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

async function recordInboundToHistory(
  config: MessagingRouterConfig,
  sessionId: string,
  message: InboundMessage,
  userId?: string,
): Promise<void> {
  const store = config.runtime.getSessionStore();
  let session = await store.get(sessionId);
  if (!session) {
    session = emptySession(sessionId, userId);
  }
  session.messages.push({ role: 'user', content: message.text ?? '' });
  session.updatedAt = new Date();
  await store.save(session);
}

export function createMessagingRouter(config: MessagingRouterConfig): Hono {
  const app = new Hono();
  const ledger = config.ledger ?? new InMemoryInboundLedger();
  const windowStore = config.windowStore ?? new InMemoryWindowStore();
  const sessionResolver = config.sessionResolver ?? defaultSessionResolver;
  const inboundChain = config.inputResolver
    ? new InboundResolverChain(config.inputResolver)
    : defaultInboundChain();
  const streamMapper = new StreamMapper();
  const fallbackMessage =
    config.fallbackMessage ?? "Sorry, I'm having trouble right now. Please try again.";

  const coalescing = config.inboundCoalescing;
  const coalescer = coalescing
    ? createInputCoalescer<CoalescedPipelineItem>({
        debounceMs: coalescing.debounceMs,
        maxWaitMs: coalescing.maxWaitMs,
        maxMessages: coalescing.maxMessages,
        timer: coalescing.timer,
        flushImmediately:
          coalescing.flushImmediately ?? ((item) => item.selection !== undefined),
      })
    : undefined;

  for (const [name, platform] of Object.entries(config.platforms)) {
    const pipeline = new OutboundPipeline(buildOutboundChain(config.outbound), platform);
    const outboundSender = new PipelineOutboundSender(
      streamMapper,
      platform,
      pipeline,
      windowStore,
      config.responseMapper,
    );
    const inboundRuntime: InboundRuntime = {
      ledger,
      window: windowStore,
      consent: config.consent,
      ownership: config.ownership,
      media: new PlatformMediaResolver(platform),
      sender: outboundSender,
      runtime: new RuntimeTurnRunner(config.runtime),
      scheduler: config.scheduler ?? noopCoalesceScheduler,
      clock: config.clock ?? systemClock,
    };
    const inboundPipeline = createInboundPipeline([
      claimAndAppend(),
      statusReactionErrorPhase({
        onStatus: async (event) => {
          await config.onStatus?.(event.data);
        },
      }),
      recordWindow(),
      consentStop(),
      ownershipGate({
        resolveSession: (message) => sessionResolver.resolve(message),
        recordHumanOwned: (message, sessionId, userId) =>
          recordInboundToHistory(config, sessionId, message, userId),
      }),
      resolveAndAttachMedia(inboundChain),
      coalesceMessages(coalescer),
      runTurn(),
    ]);

    platform.onMessage(async (message) => {
      try {
        await inboundPipeline.ingest(
          conversationKeyFromMessage(name, message),
          messageEvent(message),
          inboundRuntime,
        );
      } catch (error) {
        await sendFallback({
          error: error as Error,
          fallbackMessage,
          message,
          platformName: name,
          pipeline,
          windowStore,
          config,
        });
      }
    });

    platform.onStatus(async (status) => {
      await inboundPipeline.ingest(conversationKeyFromStatus(name, status), statusEvent(status), inboundRuntime);
    });

    platform.onReaction(async (reaction) => {
      await inboundPipeline.ingest(
        conversationKeyFromReaction(name, reaction),
        reactionEvent(reaction, inboundRuntime.clock.now()),
        inboundRuntime,
      );
    });

    app.get(`/${name}/webhook`, async (c) => {
      return platform.handleWebhook(c.req.raw);
    });

    app.post(`/${name}/webhook`, async (c) => {
      return platform.handleWebhook(c.req.raw);
    });
  }

  const hasAnyProbe = Object.values(config.platforms).some(
    (p) => typeof p.healthCheck === 'function',
  );
  if (hasAnyProbe) {
    app.get('/health', async (c) => {
      const results: Record<string, { ok: boolean; reason?: string; details?: Record<string, unknown> }> = {};
      let allOk = true;
      for (const [name, platform] of Object.entries(config.platforms)) {
        if (typeof platform.healthCheck !== 'function') continue;
        try {
          const r = await platform.healthCheck();
          results[name] = r;
          if (!r.ok) allOk = false;
        } catch (err) {
          results[name] = { ok: false, reason: (err as Error).message };
          allOk = false;
        }
      }
      return c.json({ ok: allOk, platforms: results }, allOk ? 200 : 503);
    });
  }

  return app;
}

class RuntimeTurnRunner implements TurnRunner {
  constructor(private readonly runtime: MessagingRouterConfig['runtime']) {}

  async runTurn(args: Parameters<TurnRunner['runTurn']>[0]): Promise<TurnResult> {
    const handle = this.runtime.run({
      input: args.input,
      sessionId: args.sessionId,
      userId: args.userId,
      selection: args.selection,
      abortSignal: args.signal,
    });
    const parts = await collectParts(handle.events);
    return turnResult(parts);
  }

  async deliverSignal(args: Parameters<TurnRunner['deliverSignal']>[0]): Promise<TurnResult> {
    const handle = this.runtime.run({
      sessionId: args.sessionId,
      signalDelivery: args.signal,
      abortSignal: args.signal2,
    });
    const parts = await collectParts(handle.events);
    return turnResult(parts);
  }
}

class PipelineOutboundSender implements OutboundSender {
  constructor(
    private readonly streamMapper: StreamMapper,
    private readonly platform: Parameters<StreamMapper['mapParts']>[1],
    private readonly pipeline: OutboundPipeline,
    private readonly windowStore: WindowStore,
    private readonly responseMapper: MessagingRouterConfig['responseMapper'],
  ) {}

  async send(ctx: InboundContext, result: TurnResult): Promise<void> {
    const threadId = threadIdForContext(ctx);
    await this.streamMapper.mapParts(result.parts, this.platform, threadId, {
      responseMapper: this.responseMapper,
      pipeline: this.pipeline,
      windowStore: this.windowStore,
      sessionId: ctx.sessionId ?? conversationKeyToString(ctx.key),
      userId: ctx.userId,
    });
  }
}

async function collectParts(stream: AsyncIterable<HarnessStreamPart>): Promise<HarnessStreamPart[]> {
  const parts: HarnessStreamPart[] = [];
  for await (const part of stream) {
    parts.push(part);
  }
  return parts;
}

function turnResult(parts: HarnessStreamPart[]): TurnResult {
  return {
    parts,
    suspended: suspendedPart(parts),
    handoffToHuman: parts.some((part) => part.type === 'handoff' && part.targetAgent === 'human'),
  };
}

function suspendedPart(parts: HarnessStreamPart[]): { signalId: string } | undefined {
  const paused = parts.find(
    (part): part is Extract<HarnessStreamPart, { type: 'paused' }> => part.type === 'paused',
  );
  return paused ? { signalId: paused.waitingFor } : undefined;
}

async function sendFallback(args: {
  error: Error;
  fallbackMessage: string;
  message: InboundMessage;
  platformName: string;
  pipeline: OutboundPipeline;
  windowStore: WindowStore;
  config: MessagingRouterConfig;
}): Promise<void> {
  const resolved = await (args.config.sessionResolver ?? defaultSessionResolver).resolve(args.message);
  try {
    const window = await args.windowStore.get(args.message.threadId);
    await args.pipeline.send({
      threadId: args.message.threadId,
      platform: args.platformName,
      payload: { kind: 'text', text: args.fallbackMessage },
      meta: { window, parts: [], sessionId: resolved.sessionId, userId: resolved.userId },
    });
  } catch {
    // Preserve previous behavior: fallback send failure is swallowed, original error is reported.
  }

  const errorContext: ErrorContext = {
    message: args.message,
    platform: args.platformName,
    error: args.error,
  };
  args.config.onError?.(args.error, errorContext);
}

function messageEvent(message: InboundMessage): InboundEvent {
  return {
    kind: 'message',
    id: message.id,
    ts: message.timestamp.getTime(),
    data: message,
  };
}

function statusEvent(status: StatusUpdate): InboundEvent {
  return {
    kind: 'status',
    id: `status:${status.messageId}:${status.status}:${status.timestamp.getTime()}`,
    ts: status.timestamp.getTime(),
    data: status,
  };
}

function reactionEvent(reaction: ReactionData, now: number): InboundEvent {
  return {
    kind: 'reaction',
    id: `reaction:${reaction.messageId}:${reaction.userId}:${reaction.emoji}:${reaction.action}`,
    ts: now,
    data: reaction,
  };
}

function conversationKeyFromMessage(platformName: string, message: InboundMessage): ConversationKey {
  return conversationKeyFromThread(message.platform || platformName, message.threadId);
}

function conversationKeyFromStatus(platformName: string, status: StatusUpdate): ConversationKey {
  return conversationKeyFromThread(platformName, status.threadId ?? status.recipientId);
}

function conversationKeyFromReaction(platformName: string, reaction: ReactionData): ConversationKey {
  return conversationKeyFromThread(platformName, reaction.userId);
}

function conversationKeyFromThread(platform: string, threadId: string): ConversationKey {
  const parts = threadId.split(':');
  if (parts.length >= 3 && parts[0] === platform) {
    return {
      platform,
      businessId: parts[1]!,
      threadId: parts.slice(2).join(':'),
    };
  }
  return {
    platform,
    businessId: 'default',
    threadId,
  };
}

function threadIdForContext(ctx: InboundContext): string {
  if (ctx.event.kind === 'message') return ctx.event.data.threadId;
  if (ctx.event.kind === 'status' && ctx.event.data.threadId) return ctx.event.data.threadId;
  return conversationKeyToString(ctx.key);
}
