import {
  createCallbackTextOutput,
  type CallbackTextOutputInstance,
} from '@kuralle-agents/transport-base';

/**
 * Text output for Twilio Media Streams.
 *
 * Twilio Media Streams is audio-focused; this output forwards each text
 * chunk as a Twilio `mark` event containing a monotonically-numbered name
 * so the caller can correlate transcription events with audio playback.
 *
 * Uses the shared `createCallbackTextOutput` factory from transport-base;
 * the serialize step emits a mark-name string, and the send step invokes
 * the Twilio send callback the transport adapter installs.
 */
export class TwilioTextOutput {
  private markCount = 0;
  private sendCallback: (markName: string) => void = () => {};
  readonly output: CallbackTextOutputInstance;

  constructor() {
    this.output = createCallbackTextOutput({
      serialize: ({ text, isFinal }) => {
        if (isFinal || text.length === 0) return null;
        this.markCount += 1;
        return `agent_response_${this.markCount}`;
      },
      send: (payload) => {
        try {
          this.sendCallback(payload as string);
        } catch (error) {
          console.error('[TwilioTextOutput] Error sending mark:', {
            error: error instanceof Error ? error.message : String(error),
            timestamp: new Date().toISOString(),
          });
        }
      },
      contextLabel: 'twilio',
      logPrefix: '[TwilioTextOutput]',
      emitFinalOnFlush: false,
    });
  }

  setSendCallback(callback: (markName: string) => void): void {
    this.sendCallback = callback;
  }
}
