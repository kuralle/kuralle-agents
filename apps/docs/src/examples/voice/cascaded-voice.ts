import { KuralleVoiceSession } from '@kuralle-agents/livekit-plugin';
import { GeminiLiveSTT, GeminiLiveTTS } from '@kuralle-agents/livekit-plugin/gemini';
import { WebSocketAgentServer } from '@kuralle-agents/livekit-plugin-transport-ws';
import { createRuntime, defineAgent } from '@kuralle-agents/core';
import { openai } from '@ai-sdk/openai';

const agent = defineAgent({
  id: 'support',
  instructions: 'You are a helpful support agent.',
  model: openai('gpt-4o-mini'),
});

const runtime = createRuntime({
  agents: [agent],
  defaultAgentId: 'support',
});

const server = new WebSocketAgentServer({ port: 8080 });

server.onConnection(async (transport) => {
  const session = new KuralleVoiceSession({
    runtime,
    stt: new GeminiLiveSTT(),
    tts: new GeminiLiveTTS(),
    greeting: 'Hello, how can I help?',
  });
  await server.startSession(transport, session);
});

await server.listen();
