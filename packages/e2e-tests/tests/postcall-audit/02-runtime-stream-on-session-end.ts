/**
 * Post-call audit: text Runtime.stream does not invoke authority.closeSession → onSessionEnd stays cold.
 * Run: bun run packages/e2e-tests/tests/postcall-audit/02-runtime-stream-on-session-end.ts
 */
import { Runtime } from '@kuralle-agents/core';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';

const DEFAULT_USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

function textChunks(text: string) {
  const id = 'txt' as const;
  return [
    { type: 'stream-start' as const, warnings: [] as const },
    { type: 'text-start' as const, id },
    { type: 'text-delta' as const, id, delta: text },
    { type: 'text-end' as const, id },
    {
      type: 'finish' as const,
      usage: DEFAULT_USAGE,
      finishReason: { unified: 'stop' as const, raw: undefined },
    },
  ];
}

const model = new MockLanguageModelV3({
  // Mock stream shape matches ai/test patterns; cast avoids brittle v3 stream part typing here.
  doStream: async () =>
    ({
      stream: simulateReadableStream({ chunks: textChunks('Hello from mock.') }),
    }) as never,
});

let onSessionEndCalls = 0;

const runtime = new Runtime({
  agents: [
    {
      id: 'text-audit',
      name: 'Text audit',
      type: 'llm',
      prompt: 'You are brief.',
      tools: {},
    },
  ],
  defaultAgentId: 'text-audit',
  defaultModel: model,
  hooks: {
    onSessionEnd: async () => {
      onSessionEndCalls += 1;
    },
  },
});

for await (const _part of runtime.stream({ input: 'Hi' })) {
  /* drain */
}

console.log(
  JSON.stringify(
    {
      script: '02-runtime-stream-on-session-end.ts',
      onSessionEndCallsAfterOneStreamTurn: onSessionEndCalls,
      conclusion: 'Text Runtime.stream completes turns without authority.closeSession; onSessionEnd is not fired.',
    },
    null,
    2,
  ),
);
