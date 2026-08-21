import { simulateReadableStream } from 'ai/test';

const mockFinishReason = { unified: 'stop' as const, raw: undefined };

function mockUsage(promptTokens = 1) {
  return {
    inputTokens: {
      total: promptTokens,
      noCache: promptTokens,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: {
      total: promptTokens,
      text: promptTokens,
      reasoning: undefined,
    },
  };
}

export function mockV3GenerateResult(text: string, promptTokens = 1) {
  return {
    content: [{ type: 'text' as const, text }],
    finishReason: mockFinishReason,
    usage: mockUsage(promptTokens),
    warnings: [],
  };
}

export function mockV3StreamResult(text: string, promptTokens = 1) {
  const usage = mockUsage(promptTokens);
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: 'text-start' as const, id: 't0' },
        { type: 'text-delta' as const, id: 't0', delta: text },
        { type: 'text-end' as const, id: 't0' },
        { type: 'finish' as const, finishReason: mockFinishReason, usage },
      ],
    }),
  };
}

/** Compaction tests key off real prompt-token counts, not message estimates. */
export const mockV3CompactionPromptTokens = 500;
