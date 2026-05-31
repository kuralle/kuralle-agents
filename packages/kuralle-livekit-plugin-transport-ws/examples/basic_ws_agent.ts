/**
 * Basic voice agent over WebSocket using Kuralle.
 *
 * This example shows how to run an Kuralle voice agent over a plain
 * WebSocket connection -- no LiveKit server needed.
 *
 * Usage:
 *   bun run build
 *   npx tsx examples/basic_ws_agent.ts
 *
 * Then connect a WebSocket client to ws://localhost:8080 and send
 * raw PCM audio (24kHz, mono, signed 16-bit LE) as binary messages.
 */

// Use relative imports since we're in the same package
import { WebSocketAgentServer } from '../src/index.js';
import { KuralleVoiceSession } from '@kuralle-agents/livekit-plugin';
import { Runtime } from '@kuralle-agents/core';
import { openai } from '@ai-sdk/openai';
import { GeminiLiveSTT, GeminiLiveTTS } from '@kuralle-agents/livekit-plugin/gemini';
import { initializeLogger, voice } from '@livekit/agents';

// Create Kuralle Runtime with LLM configured
const runtime = new Runtime({
  agents: [
    {
      id: 'assistant',
      name: 'Voice Assistant',
      model: openai('gpt-4o-mini'),
      instructions: `You are a helpful voice assistant.

Guidelines:
- Speak naturally and conversationally
- Keep responses concise (1-2 sentences when possible)
- If you need to collect information, ask specific questions
- Be friendly and professional`,
    },
  ],
  defaultAgentId: 'assistant',
  defaultModel: openai('gpt-4o-mini'),
});

initializeLogger({ pretty: true });

const server = new WebSocketAgentServer({
  port: 8080,
  defaultSampleRate: 24000,
});

server.onConnection(async (transport) => {
  console.log(`New connection: ${transport.id}`);

  // Create an Kuralle voice session with Gemini STT/TTS
  const voiceSession = new KuralleVoiceSession({
    runtime: runtime, // LLM comes from runtime!
    stt: new GeminiLiveSTT(),
    tts: new GeminiLiveTTS(),
    greeting: 'Hello! How can I help you today?',
  });

  // Start the session with this transport
  const session = await server.startSession(transport, voiceSession);

  // Listen for session close
  session.on(voice.AgentSessionEventTypes.Close, () => {
    console.log(`Session ${transport.id} closed`);
  });
});

// Start the server
server.listen().then(() => {
  console.log('WebSocket Kuralle agent server listening on ws://0.0.0.0:8080');
}).catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
