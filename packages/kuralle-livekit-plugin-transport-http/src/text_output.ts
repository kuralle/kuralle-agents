import {
  createCallbackTextOutput,
  type CallbackTextOutputInstance,
} from '@kuralle-agents/transport-base';
import type { SSEWriter, AgentTextEvent } from './sse.js';

/**
 * Streams agent text responses to the client via SSE events, built on top
 * of {@link createCallbackTextOutput}. The factory handles segment
 * lifecycle + logging; we supply the SSE writer wiring.
 */
export class HTTPTextOutput {
  private sseWriter: SSEWriter | null = null;
  readonly output: CallbackTextOutputInstance;

  constructor() {
    this.output = createCallbackTextOutput({
      contextLabel: 'http',
      logPrefix: '[HTTPTextOutput]',
      serialize: ({ text, isFinal }) => {
        if (!this.sseWriter) return null;
        const event: AgentTextEvent = { text, isFinal };
        return JSON.stringify(event);
      },
      send: (payload) => {
        if (!this.sseWriter) return;
        const event = JSON.parse(payload as string) as AgentTextEvent;
        this.sseWriter.writeEvent('agent_text', event);
      },
    });
  }

  setSSEWriter(writer: SSEWriter): void {
    this.sseWriter = writer;
  }
}
