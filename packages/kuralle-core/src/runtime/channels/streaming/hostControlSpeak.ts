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
    const buffered: string[] = [];
    let sourceDone = false;

    const consume = (async () => {
      try {
        for await (const { delta } of source) {
          buffered.push(delta);
          if (getToolControl()) {
            return;
          }
        }
      } finally {
        sourceDone = true;
      }
    })();

    const guardVerdict = await guard;
    await consume;

    const toolControl = getToolControl();
    if (toolControl) {
      return { text: '', control: toolControl };
    }
    // Guard is a forgot-to-route net: only honor it when the model produced no
    // substantive answer. A real answer is authoritative (model chose keep).
    const answered = buffered.join('').trim().length > 0;
    const guardControl = guardVerdictToControl(guardVerdict);
    if (guardControl && !answered) {
      return { text: '', control: guardControl };
    }

    const replaySource: TokenSource = {
      async *[Symbol.asyncIterator]() {
        for (const delta of buffered) {
          yield { delta };
        }
      },
    };

    if (!sourceDone && buffered.length === 0) {
      return { text: '', control: undefined };
    }

    return speakGated({ ctx, mode, turnId, source: replaySource, runGate });
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
