import {
  createCallbackTextOutput,
  type CallbackTextOutputInstance,
} from '@kuralle-agents/transport-base';
import type { WebSocket } from 'ws';
import { serializeServerMessage, type AgentTextMessage } from './protocol.js';

/**
 * Sends agent transcription text to the WebSocket client as JSON messages,
 * built on top of {@link createCallbackTextOutput}.
 *
 * The factory handles segment lifecycle (first-chunk log line, flush log
 * line, per-segment index). We only supply the serialize (AgentTextMessage
 * JSON) + send (ws.send wrapped in try/catch) strategy.
 */
export function createWebSocketTextOutput(
  ws: WebSocket,
  contextLabel: string = 'unknown',
): CallbackTextOutputInstance {
  return createCallbackTextOutput({
    contextLabel,
    logPrefix: '[WebSocketTextOutput]',
    serialize: ({ text, isFinal }) => {
      const msg: AgentTextMessage = {
        type: 'agent_text',
        text,
        isFinal,
      };
      return serializeServerMessage(msg);
    },
    send: (payload) => {
      try {
        ws.send(payload);
      } catch {
        // WebSocket closed
      }
    },
  });
}

/** @deprecated Use {@link createWebSocketTextOutput}. Kept for backward compat in downstream samples. */
export const WebSocketTextOutput = createWebSocketTextOutput;
