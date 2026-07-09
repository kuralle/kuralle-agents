import {
  TextOutput,
  isTimedString,
  type TimedString,
} from '@kuralle-agents/livekit-plugin';

export interface CallbackTextOutputOptions {
  /**
   * Called with every non-empty text chunk as it arrives. Return a frame
   * (string or Uint8Array). The factory dispatches the result through
   * {@link send}.
   */
  serialize: (parts: { text: string; isFinal: boolean }) => string | Uint8Array | null;
  /**
   * Called with the serialized payload. Callers typically pipe this straight
   * to a WebSocket / SSE writer / PBX tunnel. May be sync or async. Errors
   * thrown here are swallowed — the TextOutput never propagates send
   * failures up the voice pipeline (matches existing transport behavior).
   */
  send: (payload: string | Uint8Array) => void | Promise<void>;
  /**
   * Context label embedded in console logs (one "first chunk" + "segment
   * flushed" pair per logical utterance). Matches the label shape used by
   * the current per-transport TextOutput subclasses.
   */
  contextLabel?: string;
  /**
   * Explicit label for the logger prefix. Defaults to `[CallbackTextOutput]`.
   */
  logPrefix?: string;
  /** Optional chained TextOutput — invoked after the callback per captureText/flush. */
  next?: TextOutput;
  /**
   * If true (default), `flush()` emits one final serialize({ text:'', isFinal:true })
   * call so consumers receive an explicit "segment done" marker.
   */
  emitFinalOnFlush?: boolean;
}

export type CallbackTextOutputInstance = TextOutput & {
  close(): Promise<void>;
};

/**
 * Factory that produces a `TextOutput` matching the shape each transport
 * previously hand-rolled (ws, http, sip, twilio, smartpbx). One utterance is
 * modeled as a segment: the first non-empty `captureText` opens it, every
 * subsequent call appends, and `flush()` closes it.
 *
 * Why a factory instead of a concrete subclass: the wire format differs per
 * transport (JSON `{type:"agent_text",...}` for ws, SSE event string for
 * http, PBX text frame for smartpbx…). The *shape* of segment lifecycle,
 * logging, and chain-forwarding is identical. Callers supply the
 * serialization + delivery; the factory handles the rest.
 */
export function createCallbackTextOutput(
  options: CallbackTextOutputOptions,
): CallbackTextOutputInstance {
  const {
    serialize,
    send,
    contextLabel = 'unknown',
    logPrefix = '[CallbackTextOutput]',
    next,
    emitFinalOnFlush = true,
  } = options;

  class CallbackTextOutput extends TextOutput {
    private closed = false;
    private segmentIndex = 0;
    private segmentStartedAt: number | null = null;

    constructor() {
      super(next);
    }

    async captureText(text: string | TimedString): Promise<void> {
      if (this.closed) return;

      const textContent = isTimedString(text) ? text.text : text;

      if (textContent.length > 0 && this.segmentStartedAt === null) {
        this.segmentIndex += 1;
        this.segmentStartedAt = Date.now();
        console.info(`${logPrefix} first chunk`, {
          context: contextLabel,
          segmentIndex: this.segmentIndex,
          chars: textContent.length,
          timestamp: new Date().toISOString(),
        });
      }

      const payload = serialize({ text: textContent, isFinal: false });
      if (payload !== null) {
        try {
          await send(payload);
        } catch {
          // Swallow — the transport will surface errors on its own event channel.
        }
      }

      if (this.nextInChain) {
        await (this.nextInChain as TextOutput).captureText(text);
      }
    }

    flush(): void {
      if (!this.closed) {
        if (this.segmentStartedAt !== null) {
          console.info(`${logPrefix} segment flushed`, {
            context: contextLabel,
            segmentIndex: this.segmentIndex,
            durationMs: Date.now() - this.segmentStartedAt,
            timestamp: new Date().toISOString(),
          });
        }
        this.segmentStartedAt = null;

        if (emitFinalOnFlush) {
          const payload = serialize({ text: '', isFinal: true });
          if (payload !== null) {
            try {
              const maybePromise = send(payload);
              if (maybePromise && typeof (maybePromise as Promise<void>).catch === 'function') {
                (maybePromise as Promise<void>).catch(() => {});
              }
            } catch {
              // swallow
            }
          }
        }
      }

      if (this.nextInChain) {
        (this.nextInChain as TextOutput).flush();
      }
    }

    async close(): Promise<void> {
      this.closed = true;
    }
  }

  return new CallbackTextOutput();
}
