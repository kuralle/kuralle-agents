import { VoiceEngine, createGeminiClientFactory } from '@kuralle-agents/realtime-audio';
import { defineTool, buildToolSet } from '@kuralle-agents/core';
import { z } from 'zod';

const lookupOrder = defineTool({
  name: 'lookup_order',
  description: 'Look up an order by ID',
  input: z.object({ orderId: z.string() }),
  execute: async ({ orderId }) => ({ status: 'shipped', orderId }),
});

const engine = new VoiceEngine({
  agents: [
    {
      id: 'support',
      name: 'Voice Support Agent',
      instructions: 'You are a helpful voice support agent.',
      voice: 'Charon',
      tools: buildToolSet({ lookup_order: lookupOrder }),
    },
  ],
  defaultAgentId: 'support',
  modelClientFactory: createGeminiClientFactory({
    apiKey: process.env.GOOGLE_API_KEY!,
    model: 'gemini-2.5-flash-preview-native-audio',
  }),
});

// When a WebSocket or LiveKit connection arrives, accept it as a call:
//
//   const session = await engine.acceptCall({
//     callId: crypto.randomUUID(),
//     transport: yourTransportSession,  // implements TransportSession
//   });
//   await session.start();
