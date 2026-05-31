/**
 * Multi-Agent Handoff with Kuralle
 *
 * Demonstrates Kuralle's triage/handoff architecture with multiple
 * specialized agents. A router agent delegates to a game agent and back.
 *
 * This is the Kuralle equivalent of LiveKit's basic_tool_call_agent.ts.
 * The key difference: Kuralle handles multi-agent routing natively
 * through its TriageAgent and agent handoff system, while LiveKit uses
 * llm.handoff() at the tool level.
 *
 * Usage:
 *   npx tsx examples/multi_agent_handoff.ts
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

// --- Kuralle Runtime with multiple agents ---
const runtime = new Runtime({
  agents: [
    {
      id: 'router',
      name: 'Router Agent',
      model: openai('gpt-4o-mini'),
      instructions: `You are a helpful assistant. You can help with weather,
light control, and games. If the user wants to play a game, hand off to
the game agent.`,
      tools: {
        getWeather: tool({
          description: 'Get the weather for a given location.',
          inputSchema: z.object({
            location: z.string().describe('The location to get the weather for'),
          }),
          execute: async ({ location }) => {
            return `The weather in ${location} is sunny today.`;
          },
        }),
        toggleLight: tool({
          description: 'Turn on or off the light in a room.',
          inputSchema: z.object({
            room: z.enum(['bedroom', 'living room', 'kitchen', 'bathroom', 'office'])
              .describe('The room to control'),
            switchTo: z.enum(['on', 'off']).describe('Turn the light on or off'),
          }),
          execute: async ({ room, switchTo }) => {
            return `The light in the ${room} is now ${switchTo}.`;
          },
        }),
      },
      handoffs: ['game'],
    },
    {
      id: 'game',
      name: 'Game Agent',
      model: openai('gpt-4o-mini'),
      instructions: `You are a game agent. Play a number guessing game with
the user. Pick a random number between 1 and 100 and let the user guess.
Give hints like "higher" or "lower". When they guess correctly or want to
stop, hand off back to the router agent.`,
      tools: {
        getRandomNumber: tool({
          description: 'Generate a random number between 1 and 100.',
          inputSchema: z.object({}),
          execute: async () => {
            const number = Math.floor(Math.random() * 100) + 1;
            return `The secret number is ${number}. Remember this but don't tell the user!`;
          },
        }),
      },
      handoffs: ['router'],
    },
  ],
  defaultAgentId: 'router',
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
    greeting: "Hello! I'm your assistant. I can help with weather, lights, or we can play a game!",
    onKuralleHandoff: (from, to) => {
      console.log(`Agent handoff: ${from} → ${to}`);
    },
  });

  const session = await server.startSession(transport, voiceSession);

  session.on(voice.AgentSessionEventTypes.Close, () => {
    console.log(`Connection closed: ${transport.id}`);
  });
});

await server.listen();
console.log(`Multi-Agent Handoff Server listening on ws://0.0.0.0:${PORT}`);
