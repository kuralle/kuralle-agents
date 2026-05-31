/**
 * Basic Kuralle Voice Agent
 *
 * Minimal voice agent with a single tool, powered by Kuralle Runtime.
 * Demonstrates the standard Kuralle pattern: define a Runtime config,
 * wrap it with KuralleVoiceSession, and start via WebSocket transport.
 *
 * This is the Kuralle equivalent of LiveKit's basic_agent.ts example.
 * The key difference: Kuralle uses Runtime for agent orchestration
 * (system prompt, tools, session management) while LiveKit's Agent
 * uses direct LLM + tool wiring.
 *
 * Usage:
 *   npx tsx examples/basic_voice_agent.ts
 *
 * Connect a WebSocket client to ws://localhost:8080
 * Send binary PCM audio (24kHz, mono, signed 16-bit LE)
 */

import { WebSocketAgentServer } from '@kuralle-agents/livekit-plugin-transport-ws';
import { KuralleVoiceSession } from '@kuralle-agents/livekit-plugin';
import { Runtime } from '@kuralle-agents/core';
import { openai } from '@ai-sdk/openai';
import { GeminiLiveSTT, GeminiLiveTTS } from '@kuralle-agents/livekit-plugin/gemini';
import { initializeLogger, voice } from '@livekit/agents';
import { tool } from 'ai';
import { z } from 'zod';

const PORT = 8080;
initializeLogger({ pretty: true });

// --- Kuralle Runtime (the "brain") ---
const runtime = new Runtime({
  agents: [{
    id: 'assistant',
    name: 'Voice Assistant',
    model: openai('gpt-4o-mini'),
    instructions: `You are a helpful voice assistant. You can hear the user's
message and respond to it. Keep responses concise and conversational.`,
    tools: {
      getWeather: tool({
        description: 'Get the weather for a given location.',
        inputSchema: z.object({
          location: z.string().describe('The location to get the weather for'),
        }),
        execute: async ({ location }) => {
          return `The weather in ${location} is sunny.`;
        },
      }),
    },
  }],
  defaultAgentId: 'assistant',
  defaultModel: openai('gpt-4o-mini'),
});

// --- WebSocket Server ---
const server = new WebSocketAgentServer({ port: PORT });

server.onConnection(async (transport) => {
  console.log(`New connection: ${transport.id}`);

  const voiceSession = new KuralleVoiceSession({
    runtime,
    stt: new GeminiLiveSTT(),
    tts: new GeminiLiveTTS(),
    greeting: 'Hello, how can I help you today?',
  });

  const session = await server.startSession(transport, voiceSession);

  session.on(voice.AgentSessionEventTypes.Close, () => {
    console.log(`Connection closed: ${transport.id}`);
  });
});

await server.listen();
console.log(`Basic Voice Agent listening on ws://0.0.0.0:${PORT}`);
