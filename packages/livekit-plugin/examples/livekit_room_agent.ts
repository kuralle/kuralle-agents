/**
 * Kuralle Agent with LiveKit Rooms
 *
 * This example shows how to run an Kuralle voice agent using LiveKit's
 * room infrastructure (traditional WebRTC approach) with turn detection.
 *
 * Usage:
 *   npx tsx examples/livekit_room_agent.ts dev --log-level=debug
 *
 * Then connect to a LiveKit room at https://cloud.livekit.io/
 * or use the LiveKit CLI to join a room.
 */
import { type JobContext, ServerOptions, cli, defineAgent } from '@livekit/agents';
import { fileURLToPath } from 'node:url';
import { KuralleLivekitSession } from '@kuralle-agents/livekit-plugin';
import { GeminiLiveSTT, GeminiLiveTTS } from '@kuralle-agents/livekit-plugin/gemini';

// Define a simple agent config
const agentConfig = {
  agents: [
    {
      id: 'assistant',
      name: 'Voice Assistant',
      instructions: 'You are a helpful voice assistant. Be friendly and concise.',
    },
  ],
  defaultAgentId: 'assistant',
};

export default defineAgent({
  entry: async (ctx: JobContext) => {
    // Create an Kuralle LiveKit session with Gemini STT/TTS and turn detection
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
