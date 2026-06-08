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
    // Strict no-dispatch: emit NOTHING until the guard resolves. Buffer tokens
    // only until the guard returns — NOT the whole source — so a keep verdict
    // flushes immediately and streams the remainder live (TTFT ≈ guard latency,
    // not full-generation). Any host control (tool or guard) emits no text.
    const it = source[Symbol.asyncIterator]();
    const buffered: { delta: string }[] = [];
    let inflight: Promise<IteratorResult<{ delta: string }>> | undefined = it.next();
    const guardSentinel = guard.then(() => 'guard' as const);

    while (inflight) {
      const winner = await Promise.race([
        inflight.then((r) => ({ kind: 'chunk' as const, r })),
        guardSentinel.then(() => ({ kind: 'guard' as const })),
      ]);
      if (winner.kind === 'guard') {
        break;
      }
      if (winner.r.done) {
        inflight = undefined;
        break;
      }
      if (getToolControl()) {
        inflight = undefined;
        break;
      }
      buffered.push(winner.r.value);
      inflight = it.next();
    }

    const guardVerdict = await guard;
    const toolControl = getToolControl();
    if (toolControl) {
      return { text: '', control: toolControl };
    }
    // Guard is a forgot-to-route net: only honor it when the model produced no
    // substantive answer. A real answer is authoritative (model chose keep).
    const answered = buffered.map((b) => b.delta).join('').trim().length > 0;
    const guardControl = guardVerdictToControl(guardVerdict);
    if (guardControl && !answered) {
      return { text: '', control: guardControl };
    }

    // Keep: flush buffered, then continue streaming live (incl. the in-flight chunk).
    const flushSource: TokenSource = {
      async *[Symbol.asyncIterator]() {
        for (const chunk of buffered) {
          yield chunk;
        }
        if (inflight) {
          const r = await inflight;
          if (!r.done && !getToolControl()) {
            yield r.value;
          }
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
