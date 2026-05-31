/**
 * Kuralle Agent with LiveKit Rooms and Tools
 *
 * Runs an Kuralle voice agent inside a LiveKit room (WebRTC) with tools
 * and turn detection. This is the room-based counterpart to the WebSocket
 * examples.
 *
 * This is the Kuralle equivalent of LiveKit's basic_agent.ts but using
 * Kuralle Runtime for agent orchestration instead of direct LLM wiring.
 *
 * Usage:
 *   npx tsx examples/livekit_room_with_tools.ts dev --log-level=debug
 *
 * Then connect to a LiveKit room at https://cloud.livekit.io/
 */

import { type JobContext, ServerOptions, cli, defineAgent, initializeLogger, voice } from '@livekit/agents';
import { fileURLToPath } from 'node:url';
import { KuralleLivekitSession } from '@kuralle-agents/livekit-plugin';
import { GeminiLiveSTT, GeminiLiveTTS } from '@kuralle-agents/livekit-plugin/gemini';
import { openai } from '@ai-sdk/openai';
import { tool } from 'ai';
import { z } from 'zod';

initializeLogger({ pretty: true });

// --- Kuralle Runtime config ---
const agentConfig = {
  agents: [
    {
      id: 'assistant',
      name: 'Room Assistant',
      model: openai('gpt-4o-mini'),
      instructions: `You are a helpful voice assistant in a LiveKit room.
Be friendly and concise. You can check weather and control lights.`,
      tools: {
        getWeather: tool({
          description: 'Get the weather for a given location.',
          inputSchema: z.object({
            location: z.string().describe('The location to check'),
          }),
          execute: async ({ location }) => `The weather in ${location} is sunny.`,
        }),
        toggleLight: tool({
          description: 'Turn a light on or off in a room.',
          inputSchema: z.object({
            room: z.enum(['bedroom', 'living room', 'kitchen', 'office']).describe('The room'),
            state: z.enum(['on', 'off']).describe('On or off'),
          }),
          execute: async ({ room, state }) => `The light in the ${room} is now ${state}.`,
        }),
      },
    },
  ],
  defaultAgentId: 'assistant',
};

export default defineAgent({
  entry: async (ctx: JobContext) => {
    const session = KuralleLivekitSession({
      runtime: agentConfig,
      stt: new GeminiLiveSTT(),
      tts: new GeminiLiveTTS(),
      greeting: 'Hello! I am your Kuralle voice assistant. How can I help you today?',
    });

    await session.start({ room: ctx.room });
  },
});

cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url) }));
