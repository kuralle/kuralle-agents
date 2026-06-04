import { randomUUID } from 'node:crypto';
import type { TurnControl } from '../../../types/channel.js';
import type { RunContext } from '../../../types/run-context.js';
import { SentenceAggregator } from './SentenceAggregator.js';
import type { StreamMode } from './mode.js';

export interface TokenSource {
  [Symbol.asyncIterator](): AsyncIterator<{ delta: string }>;
}

export interface GateOutcome {
  blocked: boolean;
  text: string;
  reason?: string;
  control?: TurnControl;
  confidence?: number;
}

function emitMessage(ctx: RunContext, id: string, text: string): void {
  ctx.emit({ type: 'text-start', id });
  ctx.emit({ type: 'text-delta', id, delta: text });
  ctx.emit({ type: 'text-end', id });
}

async function emitBlockedSafeMessage(
  ctx: RunContext,
  turnId: string,
  started: boolean,
  outcome: GateOutcome,
): Promise<{ text: string; control?: TurnControl; confidence?: number }> {
  if (started) {
    ctx.emit({
      type: 'text-cancel',
      id: turnId,
      reason: outcome.reason ?? 'blocked',
    });
  }
  const safeId = randomUUID();
  emitMessage(ctx, safeId, outcome.text);
  return {
    text: outcome.text,
    control: outcome.control,
    confidence: outcome.confidence,
  };
}

export async function speakGated(args: {
  ctx: RunContext;
  mode: StreamMode;
  turnId: string;
  source: TokenSource;
  runGate: (fullOrSentence: string, final: boolean) => Promise<GateOutcome>;
}): Promise<{ text: string; control?: TurnControl; confidence?: number }> {
  const { ctx, mode, turnId, source, runGate } = args;

  if (mode === 'turn') {
    let full = '';
    try {
      for await (const { delta } of source) {
        full += delta;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.emit({ type: 'error', error: message });
      throw err instanceof Error ? err : new Error(message);
    }
    const decision = await runGate(full, true);
    emitMessage(ctx, turnId, decision.text);
    return {
      text: decision.text,
      control: decision.control,
      confidence: decision.confidence,
    };
  }

  const agg = new SentenceAggregator();
  let started = false;
  let emitted = '';

  const openOnce = () => {
    if (!started) {
      ctx.emit({ type: 'text-start', id: turnId });
      started = true;
    }
  };

  const emitCleared = (chunk: string) => {
    openOnce();
    ctx.emit({ type: 'text-delta', id: turnId, delta: chunk });
    emitted += chunk;
  };

  const gateSentence = async (
    sentence: string,
    final: boolean,
  ): Promise<{ text: string; control?: TurnControl; confidence?: number } | null> => {
    const decision = await runGate(sentence.trim(), final);
    if (decision.blocked) {
      return emitBlockedSafeMessage(ctx, turnId, started, decision);
    }
    emitCleared(sentence);
    return null;
  };

  try {
    for await (const { delta } of source) {
      if (mode === 'token') {
        openOnce();
        ctx.emit({ type: 'text-delta', id: turnId, delta });
        emitted += delta;
        continue;
      }

      for (const sentence of agg.push(delta)) {
        const blocked = await gateSentence(sentence, false);
        if (blocked) return blocked;
      }
    }

    if (mode === 'sentence') {
      const tail = agg.flush();
      if (tail) {
        const blocked = await gateSentence(tail, true);
        if (blocked) return blocked;
      }
    }

    if (started) {
      ctx.emit({ type: 'text-end', id: turnId });
    }
    return { text: emitted };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.emit({ type: 'error', error: message });
    if (started) {
      ctx.emit({ type: 'text-cancel', id: turnId, reason: message });
    }
    throw err instanceof Error ? err : new Error(message);
  }
}
