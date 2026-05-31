# Native Audio Pipeline

Single provider call per turn. The model handles STT, reasoning, and TTS internally.

## Install

```bash
bun add @kuralle-agents/core @kuralle-agents/realtime-audio @kuralle-agents/livekit-plugin-transport-ws
```

## Single-agent server (Gemini)

```ts title="server.ts"
import 'dotenv/config';
import { z } from 'zod';
import {
  createRuntime,
  defineAgent,
  defineTool,
  buildToolSet,
} from '@kuralle-agents/core';
import {
  GeminiLiveSession,
  voiceAgentToRuntimeAgent,
} from '@kuralle-agents/realtime-audio';
import { WebSocketAgentServer } from '@kuralle-agents/livekit-plugin-transport-ws';

const lookupOrder = defineTool({
  name: 'lookup_order',
  description: 'Look up an order by ID',
  input: z.object({ orderId: z.string() }),
  execute: async ({ orderId }) => ({ orderId, status: 'shipped', eta: '2 days' }),
});

const voiceAgent = {
  id: 'support',
  name: 'Support',
  instructions:
    'You are a helpful support agent on a phone call. Keep responses to 1-2 sentences.',
  voice: 'Kore',
  tools: { lookup_order: lookupOrder },
};

const runtime = createRuntime({
  agents: [voiceAgentToRuntimeAgent(voiceAgent)],
  defaultAgentId: 'support',
  voiceMode: true,
});

const gemini = {
  apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY!,
  model: 'gemini-2.5-flash-native-audio-preview-12-2025',
};

const server = new WebSocketAgentServer({ port: 8080, autoSendSessionStarted: false });

server.onConnection(async (adapter) => {
  await server.startNativeSession(adapter, {
    runtime,
    sessionId: adapter.id,
    createModelClient: () =>
      new GeminiLiveSession({ gemini, agent: voiceAgent }),
  });
});

await server.listen();
```

## defineAgent + flows

Use the same `defineAgent` / `defineFlow` / `reply` / `collect` definitions as text. Pass the agent through `voiceAgentToRuntimeAgent` when building `createRuntime({ voiceMode: true })`.

## Hooks and persistence

```ts
const runtime = createRuntime({
  agents: [voiceAgentToRuntimeAgent(voiceAgent)],
  defaultAgentId: 'support',
  voiceMode: true,
  sessionStore: redisStore,
  hooks: {
    onToolResult: async ({ toolName, result }) => console.log(toolName, result),
  },
});
```

## Extraction model for collect nodes

```ts
import { openai } from '@ai-sdk/openai';

const runtime = createRuntime({
  agents: [receptionist],
  defaultAgentId: 'receptionist',
  extractionModel: openai('gpt-4o-mini'),
  voiceMode: true,
});
```

## LiveKit rooms

For LiveKit `AgentSession` + official `RealtimeModel`, bridge with `LiveKitSessionRunner` from `@kuralle-agents/livekit-plugin` and a runtime-backed adapter. Cascaded STT→LLM→TTS uses `KuralleVoiceSession` + `createVoiceSession({ mode: 'cascaded', options })`.

Same `defineAgent` powers text via `runtime.run()` and voice via `VoiceCallSession` / native transport.
