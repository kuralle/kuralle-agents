import { TextOutput, isTimedString, type TimedString } from '@kuralle-agents/livekit-plugin';

/**
 * Text output for SIP sessions.
 *
 * SIP has no native text channel. This uses a callback pattern so the
 * application can decide how to deliver transcription text (SIP INFO,
 * webhook, parallel WebSocket, or simply discard). SIP's callback shape
 * is a strict subset of the shared `createCallbackTextOutput` factory,
 * so this class remains local rather than routing through the factory's
 * serialize + send plumbing.
 */
export class SIPTextOutput extends TextOutput {
  private textHandler:
    | ((text: string, isFinal: boolean) => void)
    | null = null;

  constructor(nextInChain?: TextOutput) {
    super(nextInChain);
  }

  onText(handler: (text: string, isFinal: boolean) => void): void {
    this.textHandler = handler;
  }

  async captureText(text: string | TimedString): Promise<void> {
    const textContent = isTimedString(text) ? text.text : text;

    if (this.textHandler) {
      this.textHandler(textContent, false);
    }

    if (this.nextInChain) {
      await (this.nextInChain as TextOutput).captureText(text);
    }
  }

  flush(): void {
    if (this.textHandler) {
      this.textHandler('', true);
    }

    if (this.nextInChain) {
      (this.nextInChain as TextOutput).flush();
    }
  }
}
