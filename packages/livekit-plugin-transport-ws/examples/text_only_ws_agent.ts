/**
 * Text-only chatbot over WebSocket using Kuralle.
 *
 * This example shows a minimal text chatbot over WebSocket with no audio.
 *
 * Usage:
 *   bun run build
 *   npx tsx examples/text_only_ws_agent.ts
 *
 * Connect to ws://localhost:8080 and send JSON messages:
 *   {"type": "user_text", "text": "Hello!"}
 */

// Use relative imports since we're in the same package
import { WebSocketAgentServer } from '../src/index.js';
import { KuralleVoiceSession } from '@kuralle-agents/livekit-plugin';
import { Runtime } from '@kuralle-agents/core';
import { openai } from '@ai-sdk/openai';
import { initializeLogger, voice } from '@livekit/agents';
import { GeminiLiveSTT, GeminiLiveTTS } from '@kuralle-agents/livekit-plugin/gemini';

// Create Kuralle Runtime with LLM configured
const runtime = new Runtime({
  agents: [
    {
      id: 'assistant',
      name: 'Text Assistant',
      model: openai('gpt-4o-mini'),
      instructions: 'You are a helpful text assistant. Keep responses brief.',
    },
  ],
  defaultAgentId: 'assistant',
  defaultModel: openai('gpt-4o-mini'),
});

const server = new WebSocketAgentServer({
  port: 8080,
});
initializeLogger({ pretty: true });

server.onConnection(async (transport) => {
  console.log(`New connection: ${transport.id}`);

  // Text input still uses the same voice session contract.
  const voiceSession = new KuralleVoiceSession({
    runtime: runtime,
    stt: new GeminiLiveSTT(),
    tts: new GeminiLiveTTS(),
    greeting: null,
  });

  const session = await server.startSession(transport, voiceSession);

  session.on(voice.AgentSessionEventTypes.Close, () => {
    console.log(`Session ${transport.id} closed`);
  });
});

// Start the server
server.listen().then(() => {
  console.log('WebSocket text agent listening on ws://0.0.0.0:8080');
}).catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
