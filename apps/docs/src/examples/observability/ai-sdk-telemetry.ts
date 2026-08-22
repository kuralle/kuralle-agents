import { trace } from '@opentelemetry/api';
import { openai } from '@ai-sdk/openai';
import {
  createRuntime,
  defineAgent,
  registerAiSdkOpenTelemetry,
} from '@kuralle-agents/core';

// AI SDK v7 traces by default once `@ai-sdk/otel` is registered — Kuralle never
// registers at import time. Opt in explicitly:
registerAiSdkOpenTelemetry({ tracer: trace.getTracer('my-app') });

const agent = defineAgent({
  id: 'support',
  instructions: 'You are a helpful support agent.',
  model: openai('gpt-4o-mini'),
});

const runtime = createRuntime({
  agents: [agent],
  defaultAgentId: 'support',
  aiSdkTelemetry: { enabled: true },
});
