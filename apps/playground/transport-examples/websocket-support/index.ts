/**
 * Customer Support Agent over WebSocket
 */

import { WebSocketAgentServer } from '@kuralle-agents/livekit-plugin-transport-ws';
import { KuralleVoiceSession } from '@kuralle-agents/livekit-plugin';
import { openai } from '@ai-sdk/openai';
import { GeminiLiveSTT, GeminiLiveTTS } from '@kuralle-agents/livekit-plugin/gemini';
import { initializeLogger, voice } from '@livekit/agents';
import { buildSupportRuntime, supportGreeting } from '../support-agent/index.js';

const PORT = 8080;
initializeLogger({ pretty: true });

const model = openai('gpt-4o-mini');
const runtime = buildSupportRuntime(model);

const server = new WebSocketAgentServer({ port: PORT });

server.onConnection(async (transport) => {
  console.log(`New connection: ${transport.id}`);

  const voiceSession = new KuralleVoiceSession({
    runtime,
    stt: new GeminiLiveSTT(),
    tts: new GeminiLiveTTS(),
    greeting: supportGreeting,
  });

  const session = await server.startSession(transport, voiceSession);

  session.on(voice.AgentSessionEventTypes.Close, () => {
    console.log(`Connection closed: ${transport.id}`);
  });
});

await server.listen();
console.log(`Customer Support Server (WebSocket) listening on ws://0.0.0.0:${PORT}`);
