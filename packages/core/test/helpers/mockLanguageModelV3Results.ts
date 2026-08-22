import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import type { ModelMessage } from 'ai';

const mockFinishReason = { unified: 'stop' as const, raw: undefined };
const mockToolCallsFinishReason = { unified: 'tool-calls' as const, raw: undefined };

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

type PromptMessage = { role: string; content: unknown };

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part && typeof part === 'object' && 'text' in part
          ? String((part as { text: unknown }).text)
          : JSON.stringify(part),
      )
      .join('');
  }
  return String(content ?? '');
}

export function extractSystemFromPrompt(prompt: readonly PromptMessage[]): string | undefined {
  const systemParts = prompt.filter((message) => message.role === 'system');
  if (systemParts.length === 0) return undefined;
  return systemParts.map((message) => contentToText(message.content)).join('\n\n');
}

export function extractPromptText(prompt: readonly PromptMessage[]): string {
  return prompt.map((message) => contentToText(message.content)).join('\n');
}

export function nonSystemMessages(prompt: readonly PromptMessage[]): ModelMessage[] {
  return prompt.filter((message) => message.role !== 'system') as ModelMessage[];
}

export function toolsRecordFromV3Tools(
  tools: ReadonlyArray<{ name: string }> | undefined,
): Record<string, unknown> {
  if (!tools || tools.length === 0) return {};
  return Object.fromEntries(tools.map((tool) => [tool.name, tool]));
}

/** Map doStream options to streamText-like args for legacy test assertions. */
export function streamTextCaptureFromDoStream(options: {
  prompt?: readonly PromptMessage[];
  tools?: ReadonlyArray<{ name: string }>;
}): Record<string, unknown> {
  const systemMessages = options.prompt?.filter((message) => message.role === 'system') ?? [];
  let system: unknown;
  if (systemMessages.length === 1 && typeof systemMessages[0]?.content === 'string') {
    system = systemMessages[0].content;
  } else if (systemMessages.length > 0) {
    system = systemMessages.map((message) => ({ role: 'system', content: message.content }));
  }
  return {
    system,
    messages: nonSystemMessages(options.prompt ?? []),
    tools: toolsRecordFromV3Tools(options.tools),
  };
}

export function mockV3ReplyModel(text = 'ok', promptTokens = 1): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doStream: async () => mockV3StreamResult(text, promptTokens),
    doGenerate: async () => mockV3GenerateResult('summary', promptTokens),
  });
}

export function mockV3StreamTextModel(text: string | readonly string[], promptTokens = 1): MockLanguageModelV3 {
  const chunks = Array.isArray(text) ? [...text] : [text];
  const usage = mockUsage(promptTokens);
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          ...chunks.flatMap((chunk, index) => [
            { type: 'text-start' as const, id: `t${index}` },
            { type: 'text-delta' as const, id: `t${index}`, delta: chunk },
            { type: 'text-end' as const, id: `t${index}` },
          ]),
          { type: 'finish' as const, finishReason: mockFinishReason, usage },
        ],
      }),
    }),
  });
}

export function mockV3CapturingStreamModel(
  captured: Record<string, unknown>[],
  text = 'ok',
  promptTokens = 1,
): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doStream: async (options) => {
      captured.push(streamTextCaptureFromDoStream(options));
      return mockV3StreamResult(text, promptTokens);
    },
  });
}

export function mockV3SummarizerModel(
  summary: string | ((ctx: { promptText: string; systemText?: string }) => string | Promise<string>),
  promptTokens = 1,
): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async (options) => {
      const prompt = options.prompt ?? [];
      const promptText = extractPromptText(prompt);
      const systemText = extractSystemFromPrompt(prompt);
      const text =
        typeof summary === 'function' ? await summary({ promptText, systemText }) : summary;
      return mockV3GenerateResult(text, promptTokens);
    },
  });
}

export function mockV3FailingSummarizerModel(error: Error | string = new Error('provider down')): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async () => {
      throw typeof error === 'string' ? new Error(error) : error;
    },
  });
}

export interface GenerateObjectCall {
  system?: string;
  messages?: ModelMessage[];
  promptText?: string;
}

export function mockV3GenerateObjectModel(
  impl: (opts: GenerateObjectCall) => Promise<{ object: Record<string, unknown> }>,
  calls?: GenerateObjectCall[],
): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async (options) => {
      const prompt = options.prompt ?? [];
      const callOpts: GenerateObjectCall = {
        system: extractSystemFromPrompt(prompt),
        messages: nonSystemMessages(prompt),
        promptText: extractPromptText(prompt),
      };
      if (calls) calls.push(callOpts);
      const { object } = await impl(callOpts);
      return mockV3GenerateResult(JSON.stringify(object));
    },
  });
}

export function mockV3ToolCallStreamResult(
  toolName: string,
  toolCallId: string,
  input = '{}',
  promptTokens = 100,
) {
  const usage = mockUsage(promptTokens);
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: 'stream-start' as const, warnings: [] },
        { type: 'tool-call' as const, toolCallId, toolName, input },
        { type: 'finish' as const, finishReason: mockToolCallsFinishReason, usage },
      ],
    }),
  };
}

export function mockV3MultiStepStreamModel(
  steps: Array<
    (callIndex: number) =>
      | ReturnType<typeof mockV3StreamResult>
      | ReturnType<typeof mockV3ToolCallStreamResult>
  >,
): MockLanguageModelV3 {
  let call = 0;
  return new MockLanguageModelV3({
    doStream: async () => {
      call += 1;
      const step = steps[Math.min(call - 1, steps.length - 1)];
      return step!(call);
    },
  });
}
