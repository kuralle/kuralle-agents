import { openai } from '@ai-sdk/openai';
import { createRuntime, defineAgent, langfuseSink, otelSink } from '@kuralle-agents/core';

const agent = defineAgent({
  id: 'support',
  instructions: 'You are a helpful support agent.',
  model: openai('gpt-4o-mini'),
});

const runtime = createRuntime({
  agents: [agent],
  defaultAgentId: 'support',
  tracing: {
    sinks: [
      otelSink({
        endpoint: 'https://collector.example.com', // '/v1/traces' appended if missing
        headers: { Authorization: `Bearer ${process.env.OTEL_TOKEN}` },
        serviceName: 'support-agent',
      }),
      langfuseSink({
        publicKey: process.env.LANGFUSE_PUBLIC_KEY!,
        secretKey: process.env.LANGFUSE_SECRET_KEY!,
        // endpoint defaults to https://cloud.langfuse.com/api/public/otel
      }),
    ],
  },
});
