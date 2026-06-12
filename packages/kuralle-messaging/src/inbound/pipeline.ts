import { mergeUserInputContents } from '@kuralle-agents/core';
import type { CoalescedInboundItem } from '../types/adapter.js';
import type { InboundMessage } from '../types/messages.js';
import type { InputCoalescer } from '../adapter/input-coalescer.js';
import type { InboundResolverChain } from '../adapter/input-resolver-chain.js';
import {
  eventSeq,
  type ConversationKey,
} from './ledger.js';
import type {
  InboundContext,
  InboundEvent,
  InboundMiddleware,
  InboundNext,
  InboundOutcome,
  InboundRuntime,
  TurnResult,
} from './types.js';

export type CoalescedPipelineItem = CoalescedInboundItem & {
  key: ConversationKey;
  eventId: string;
  seq: number;
  ctx: InboundContext;
};

export function createInboundPipeline(mw: InboundMiddleware[]): {
  ingest(key: ConversationKey, event: InboundEvent, rt: InboundRuntime): Promise<InboundOutcome>;
  flush(key: ConversationKey, rt: InboundRuntime): Promise<InboundOutcome>;
} {
  async function run(ctx: InboundContext): Promise<InboundOutcome> {
    const dispatch = (i: number): Promise<InboundOutcome> => {
      const middleware = mw[i];
      if (!middleware) return Promise.resolve({ kind: 'short', by: 'pipeline', reason: 'no-input' });
      const next: InboundNext = () => dispatch(i + 1);
      return middleware.handle(ctx, next);
    };

    const outcome = await dispatch(0);
    await finalizeIfTerminal(ctx, outcome);
    return outcome;
  }

  return {
    ingest(key, event, rt) {
      return run({ key, event, rt, locals: {} });
    },
    async flush(key, rt) {
      const events = await rt.ledger.readUnprocessed(key);
      let last: InboundOutcome = { kind: 'short', by: 'pipeline', reason: 'no-input' };
      for (const event of events) {
        last = await run({ key, event, rt, locals: { replay: true } });
      }
      return last;
    },
  };
}

async function finalizeIfTerminal(
  ctx: InboundContext,
  outcome: InboundOutcome,
): Promise<void> {
  if (ctx.locals.claimResult !== 'claimed' || outcome.kind === 'buffered') return;
  await completeAndCommit(ctx, ctx.event.id);
}

async function completeAndCommit(ctx: InboundContext, eventId: string): Promise<void> {
  await ctx.rt.ledger.complete(ctx.key, eventId);
  const seq = typeof ctx.locals.seq === 'number' ? ctx.locals.seq : eventSeq(ctx.event);
  const cursor = typeof ctx.locals.cursor === 'number' ? ctx.locals.cursor : 0;
  if (seq !== undefined) {
    const committed = await ctx.rt.ledger.commitCursor(ctx.key, seq, cursor);
    if (!committed) {
      await ctx.rt.ledger.commitCursor(ctx.key, seq, seq - 1);
    }
  }
}

export function claimAndAppend(): InboundMiddleware {
  return {
    name: 'claim',
    async handle(ctx, next) {
      const claim = await ctx.rt.ledger.claim(ctx.key, ctx.event.id);
      ctx.locals.claimResult = claim;
      if (claim === 'duplicate') {
        return { kind: 'short', by: 'claim', reason: 'duplicate' };
      }
      if (claim === 'in_progress') {
        return { kind: 'short', by: 'claim', reason: 'in-progress' };
      }

      const cursorBefore = await currentCursor(ctx);
      const { seq } = await ctx.rt.ledger.append(ctx.key, ctx.event);
      ctx.locals.seq = seq;
      ctx.locals.cursor = cursorBefore;
      return next();
    },
  };
}

async function currentCursor(ctx: InboundContext): Promise<number> {
  const events = await ctx.rt.ledger.readUnprocessed(ctx.key);
  const seqs = events.map((event) => eventSeq(event)).filter((seq): seq is number => seq !== undefined);
  const minSeq = Math.min(...seqs, Number.POSITIVE_INFINITY);
  return minSeq === Number.POSITIVE_INFINITY ? 0 : minSeq - 1;
}

export function statusReactionErrorPhase(options?: {
  onStatus?: (status: InboundEvent & { kind: 'status' }) => Promise<void>;
  onReaction?: (reaction: InboundEvent & { kind: 'reaction' }) => Promise<void>;
  onErrorEvent?: (event: InboundEvent & { kind: 'error' }) => Promise<void>;
}): InboundMiddleware {
  return {
    name: 'phase-handler',
    async handle(ctx, next) {
      if (ctx.event.kind === 'status') {
        const status = ctx.event.data;
        if (status.conversation?.expirationTimestamp && status.threadId) {
          await ctx.rt.window.recordExpiry(status.threadId, status.conversation.expirationTimestamp);
        }
        await options?.onStatus?.(ctx.event);
        return { kind: 'short', by: 'phase-handler', reason: 'status' };
      }
      if (ctx.event.kind === 'reaction') {
        await options?.onReaction?.(ctx.event);
        return { kind: 'short', by: 'phase-handler', reason: 'reaction' };
      }
      if (ctx.event.kind === 'error') {
        await options?.onErrorEvent?.(ctx.event);
        return { kind: 'short', by: 'phase-handler', reason: 'error' };
      }
      return next();
    },
  };
}

export function recordWindow(): InboundMiddleware {
  return {
    name: 'record-window',
    async handle(ctx, next) {
      if (ctx.event.kind === 'message') {
        await ctx.rt.window.recordInbound(ctx.event.data.threadId, ctx.event.data.timestamp);
      }
      return next();
    },
  };
}

export function consentStop(): InboundMiddleware {
  return {
    name: 'consent-stop',
    async handle(ctx, next) {
      if (
        ctx.event.kind === 'message' &&
        ctx.rt.consent &&
        ctx.event.data.text?.trim().toUpperCase() === 'STOP'
      ) {
        await ctx.rt.consent.optOut(ctx.event.data.customerId);
        return { kind: 'short', by: 'consent-stop', reason: 'opted-out' };
      }
      return next();
    },
  };
}

export function ownershipGate(options: {
  resolveSession(message: InboundMessage): Promise<{ sessionId: string; userId?: string }>;
  recordHumanOwned(message: InboundMessage, sessionId: string, userId?: string): Promise<void>;
}): InboundMiddleware {
  return {
    name: 'ownership',
    async handle(ctx, next) {
      if (ctx.event.kind !== 'message') return next();
      const resolved = await options.resolveSession(ctx.event.data);
      ctx.sessionId = resolved.sessionId;
      ctx.userId = resolved.userId;

      if (ctx.rt.ownership && (await ctx.rt.ownership.owner(ctx.event.data.threadId)) === 'human') {
        await options.recordHumanOwned(ctx.event.data, resolved.sessionId, resolved.userId);
        return { kind: 'short', by: 'ownership', reason: 'human-owned' };
      }

      return next();
    },
  };
}

export function resolveAndAttachMedia(inboundChain: InboundResolverChain): InboundMiddleware {
  return {
    name: 'resolve-media',
    async handle(ctx, next) {
      if (ctx.event.kind !== 'message') return next();
      const { input: resolvedInput, selection } = await inboundChain.resolve(ctx.event.data);
      ctx.input = await ctx.rt.media.resolve(ctx.event.data, resolvedInput);
      ctx.selection = selection;
      return next();
    },
  };
}

export function coalesceMessages(
  coalescer: InputCoalescer<CoalescedPipelineItem> | undefined,
): InboundMiddleware {
  return {
    name: 'coalesce',
    async handle(ctx, next) {
      if (!coalescer || ctx.event.kind !== 'message') return next();
      if (ctx.input === undefined) return { kind: 'short', by: 'coalesce', reason: 'no-input' };
      const seq = typeof ctx.locals.seq === 'number' ? ctx.locals.seq : eventSeq(ctx.event);
      if (seq === undefined) return next();

      coalescer.push(
        ctx.event.data.threadId,
        {
          key: ctx.key,
          eventId: ctx.event.id,
          seq,
          input: ctx.input,
          selection: ctx.selection,
          sessionId: ctx.sessionId ?? `${ctx.key.platform}:${ctx.key.businessId}:${ctx.key.threadId}`,
          userId: ctx.userId,
          message: ctx.event.data,
          platform: ctx.key.platform,
          ctx,
        },
        async (items) => {
          await runCoalesced(items);
        },
      );
      return { kind: 'buffered' };
    },
  };
}

async function runCoalesced(items: CoalescedPipelineItem[]): Promise<void> {
  if (items.length === 0) return;
  const last = items[items.length - 1]!;
  const input = mergeUserInputContents(items.map((item) => item.input)) ?? '';
  const result = await last.ctx.rt.runtime.runTurn({
    key: last.key,
    input,
    selection: last.selection,
    sessionId: last.sessionId,
    userId: last.userId,
  });
  await last.ctx.rt.sender.send(last.ctx, result);
  if (result.handoffToHuman && last.ctx.rt.ownership && last.ctx.event.kind === 'message') {
    await last.ctx.rt.ownership.claim(last.ctx.event.data.threadId, 'human');
  }
  for (const item of items) {
    await item.ctx.rt.ledger.complete(item.key, item.eventId);
  }
  const throughSeq = Math.max(...items.map((item) => item.seq));
  await last.ctx.rt.ledger.commitCursor(last.key, throughSeq, throughSeq - items.length);
}

export function runTurn(): InboundMiddleware {
  return {
    name: 'run-turn',
    async handle(ctx) {
      let result: TurnResult;
      if (ctx.event.kind === 'signal') {
        result = await ctx.rt.runtime.deliverSignal({
          key: ctx.key,
          sessionId: ctx.sessionId ?? `${ctx.key.platform}:${ctx.key.businessId}:${ctx.key.threadId}`,
          signal: {
            signalId: ctx.event.data.signalId,
            name: ctx.event.data.name,
            payload: ctx.event.data.payload,
          },
        });
      } else if (ctx.event.kind === 'message' && ctx.input !== undefined) {
        result = await ctx.rt.runtime.runTurn({
          key: ctx.key,
          input: ctx.input,
          selection: ctx.selection,
          sessionId: ctx.sessionId,
          userId: ctx.userId,
        });
      } else {
        return { kind: 'short', by: 'run-turn', reason: 'no-input' };
      }

      await ctx.rt.sender.send(ctx, result);

      if (result.handoffToHuman && ctx.rt.ownership && ctx.event.kind === 'message') {
        await ctx.rt.ownership.claim(ctx.event.data.threadId, 'human');
      }

      if (result.suspended) return { kind: 'suspended', signalId: result.suspended.signalId };
      return { kind: 'ran', parts: result.parts };
    },
  };
}
