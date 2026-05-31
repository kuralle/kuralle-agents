/**
 * Twilio Media Streams Transport for Kuralle Agents
 *
 * Enables Kuralle voice agents to work with Twilio Media Streams API.
 * Compatible with Cloudflare Workers, Node.js, and any WebSocket-enabled runtime.
 *
 * Features:
 * - G.711 μ-law codec support (Twilio standard)
 * - Automatic resampling (8kHz ↔ 24kHz)
 * - Cloudflare Workers compatible
 * - Session management integration
 *
 * Basic usage (Cloudflare Workers):
 * ```typescript
 * import { createTwilioWorker } from '@kuralle-agents/livekit-plugin-transport-twilio/cloudflare';
 *
 * export default createTwilioWorker({
 *   agent: () => createKuralleSession({...}),
 * });
 * ```
 *
 * Basic usage (Node.js/any WebSocket):
 * ```typescript
 * import { WebSocketServer } from 'ws';
 * import { TwilioTransportAdapter } from '@kuralle-agents/livekit-plugin-transport-twilio';
 * import { createKuralleSession } from '@kuralle-agents/livekit-plugin';
 *
 * const wss = new WebSocketServer({ port: 8080 });
 *
 * wss.on('connection', (ws, req) => {
 *   const transport = new TwilioTransportAdapter({
 *     send: (msg) => ws.send(msg),
 *   });
 *
 *   ws.on('message', (data) => {
 *     transport.handleMessage(data.toString());
 *   });
 *
 *   const { agent, sessionOptions } = createKuralleSession({
 *     runtime: agentConfig,
 *     stt: new GeminiLiveSTT(),
 *     tts: new GeminiLiveTTS(),
 *   });
 *
 *   await sessionManager.startSession(transport, agent, sessionOptions);
 * });
 * ```
 *
 * Basic usage (TwilioAgentServer):
 * ```typescript
 * import { TwilioAgentServer } from '@kuralle-agents/livekit-plugin-transport-twilio';
 * import { createKuralleSession } from '@kuralle-agents/livekit-plugin';
 *
 * const server = new TwilioAgentServer({ port: 8080 });
 *
 * server.onCall(async (callId, transport) => {
 *   const { agent, sessionOptions } = createKuralleSession({...});
 *   await server.startSession(callId, agent, sessionOptions);
 * });
 *
 * await server.listen();
 * ```
 */

// Server
export { TwilioAgentServer } from './server.js';
export type { TwilioServerOptions } from './server.js';

// Core transport
export { TwilioTransportAdapter } from './transport_adapter.js';
export type { TwilioTransportOptions } from './transport_adapter.js';

// Audio I/O
export { TwilioAudioInput } from './audio_input.js';
export { TwilioAudioOutput } from './audio_output.js';
export { TwilioTextOutput } from './text_output.js';

// Protocol utilities
export {
  parseTwilioMessage,
  isMediaEvent,
  extractMediaPayload,
  createClearMessage,
  createMarkMessage,
} from './twilio_protocol.js';
export type {
  TwilioEvent,
  TwilioMediaEvent,
  TwilioConnectedEvent,
  TwilioStartEvent,
  TwilioStopEvent,
  TwilioMarkEvent,
  TwilioClearEvent,
} from './twilio_protocol.js';

// Codec (re-exported from canonical source)
export { mulawEncodeArray, mulawDecodeArray } from '@kuralle-agents/transport-base/codec/g711';

export { createTwilioNativeAudioTransport } from './native_bridge.js';
export type { TwilioNativeWsLike } from './native_bridge.js';
