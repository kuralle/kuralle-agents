import type { TurnControl } from '../../../types/channel.js';
import type { RunContext } from '../../../types/run-context.js';
import type { HostGuardVerdict } from '../../select.js';
import { guardVerdictToControl } from '../../hostControlGuard.js';
import { speakGated, type TokenSource, type GateOutcome } from './speakGated.js';
import type { StreamMode } from './mode.js';

export async function speakWithHostControl(args: {
  ctx: RunContext;
  mode: StreamMode;
  turnId: string;
  source: TokenSource;
  runGate: (fullOrSentence: string, final: boolean) => Promise<GateOutcome>;
  dispatchMode: 'strict' | 'relaxed';
  guard?: Promise<HostGuardVerdict>;
  getToolControl: () => TurnControl | undefined;
}): Promise<{ text: string; control?: TurnControl; confidence?: number }> {
  const { ctx, mode, turnId, source, runGate, dispatchMode, guard, getToolControl } = args;

  if (dispatchMode === 'strict' && guard) {
    // Strict no-dispatch: emit NOTHING until we know keep vs route. The answer is
    // authoritative, so a guard ROUTE may only be honored once we know the model
    // did NOT answer — i.e. after the model's intent is observable. We therefore
    // buffer until the FIRST substantive token (model is answering), source end
    // (no answer), or the model's own control tool. We do NOT race the guard:
    // honoring an early guard verdict before any token would mis-route a turn the
    // model was about to answer (the answer-authoritative rule, pre-first-token).
    const it = source[Symbol.asyncIterator]();
    const buffered: { delta: string }[] = [];
    let sourceDone = false;
    let answered = false;

    while (!getToolControl()) {
      const r = await it.next();
      if (r.done) {
        sourceDone = true;
        break;
      }
      buffered.push(r.value);
      if (r.value.delta.trim().length > 0) {
        answered = true;
        break;
      }
    }

    const guardVerdict = await guard;
    const toolControl = getToolControl();
    if (toolControl) {
      return { text: '', control: toolControl };
    }
    // Guard is a forgot-to-route net: honored only when the model did not answer.
    const guardControl = guardVerdictToControl(guardVerdict);
    if (guardControl && !answered) {
      return { text: '', control: guardControl };
    }

    // Keep: flush buffered, then stream the remainder live (TTFT ≈ first token).
    const flushSource: TokenSource = {
      async *[Symbol.asyncIterator]() {
        for (const chunk of buffered) {
          yield chunk;
        }
        if (!sourceDone) {
          let cur = await it.next();
          while (!cur.done) {
            if (getToolControl()) {
              return;
            }
            yield cur.value;
            cur = await it.next();
          }
        }
      },
    };

    return speakGated({ ctx, mode, turnId, source: flushSource, runGate });
  }

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

  const spoken = await speakGated({
    ctx,
    mode,
    turnId,
    source: wrappedSource,
    runGate,
  });

  toolControl = getToolControl();
  if (toolControl) {
    if (spoken.text) {
      ctx.emit({ type: 'text-cancel', id: turnId, reason: 'host-control' });
    }
    return { text: '', control: toolControl };
  }

  // Guard is a forgot-to-route net: only override when the model produced no
  // substantive answer. A real answer is authoritative — never cancel a correct
  // keep answer because the guard disagrees (that mis-routes Q&A turns).
  if (guard && !spoken.text.trim()) {
    const guardVerdict = await guard;
    const guardControl = guardVerdictToControl(guardVerdict);
    if (guardControl) {
      return { text: '', control: guardControl };
    }
  }

  return spoken;
}
