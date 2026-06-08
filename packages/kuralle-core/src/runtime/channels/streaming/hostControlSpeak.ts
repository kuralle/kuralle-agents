import type { TurnControl } from '../../../types/channel.js';
import type { RunContext } from '../../../types/run-context.js';
import { speakGated, type TokenSource, type GateOutcome } from './speakGated.js';
import type { StreamMode } from './mode.js';

/**
 * Streaming dispatch gate. Its only job is to control EMISSION per dispatch mode
 * and surface the model's own control tool — it does NOT consult the host guard.
 * The guard has a single owner (`hostLoop`): when this returns empty text and no
 * control, `hostLoop` runs the guard exactly once. Keeping the guard out of here
 * avoids double-evaluation and keeps guard telemetry attributable.
 *
 * - relaxed: stream live; if the model's own control tool fires, cancel any
 *   streamed text and return that control.
 * - strict: emit NOTHING until the model's intent is known — buffer until the
 *   first substantive token (answering → flush + stream the rest live) or source
 *   end (no answer → return empty; `hostLoop` then guards with no leak).
 */
export async function speakWithHostControl(args: {
  ctx: RunContext;
  mode: StreamMode;
  turnId: string;
  source: TokenSource;
  runGate: (fullOrSentence: string, final: boolean) => Promise<GateOutcome>;
  dispatchMode: 'strict' | 'relaxed';
  getToolControl: () => TurnControl | undefined;
}): Promise<{ text: string; control?: TurnControl; confidence?: number }> {
  const { ctx, mode, turnId, source, runGate, dispatchMode, getToolControl } = args;

  if (dispatchMode === 'strict') {
    const it = source[Symbol.asyncIterator]();
    const buffered: { delta: string }[] = [];
    let answered = false;

    while (!getToolControl()) {
      const r = await it.next();
      if (r.done) {
        break;
      }
      buffered.push(r.value);
      if (r.value.delta.trim().length > 0) {
        answered = true;
        break;
      }
    }

    const toolControl = getToolControl();
    if (toolControl) {
      return { text: '', control: toolControl };
    }

    // No substantive text → emit nothing; hostLoop owns the empty-turn guard.
    if (!answered) {
      return { text: '', control: undefined };
    }

    // Answering: flush the buffered prefix, then stream the remainder live.
    const flushSource: TokenSource = {
      async *[Symbol.asyncIterator]() {
        for (const chunk of buffered) {
          yield chunk;
        }
        let cur = await it.next();
        while (!cur.done) {
          if (getToolControl()) {
            return;
          }
          yield cur.value;
          cur = await it.next();
        }
      },
    };

    return speakGated({ ctx, mode, turnId, source: flushSource, runGate });
  }

  // Relaxed: stream live; stop if the model's own control tool fires.
  let toolControl: TurnControl | undefined;
  const wrappedSource: TokenSource = {
    async *[Symbol.asyncIterator]() {
      for await (const chunk of source) {
        toolControl = getToolControl();
        if (toolControl) {
          return;
        }
        yield chunk;
      }
    },
  };

  const spoken = await speakGated({ ctx, mode, turnId, source: wrappedSource, runGate });

  toolControl = getToolControl();
  if (toolControl) {
    if (spoken.text) {
      ctx.emit({ type: 'text-cancel', id: turnId, reason: 'host-control' });
    }
    return { text: '', control: toolControl };
  }

  return spoken;
}
