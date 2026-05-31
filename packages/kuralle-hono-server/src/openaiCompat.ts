import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { ModelMessage } from 'ai';
import type { HarnessStreamPart, RuntimeLike, TurnHandle } from '@kuralle-agents/core';
import crypto from 'node:crypto';

type SystemPromptMode = 'agent' | 'merge';

export interface CreateOpenAICompatRouterOptions {
  runtime: RuntimeLike;
  apiKey?: string;
  agentId?: string;
  sessionKey?: (req: Context) => string | undefined;
  clientTools?: string[];
  systemPromptMode?: SystemPromptMode;
}

interface OpenAIChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | Array<{ type: string; text?: string }> | null;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
  name?: string;
}

export interface ChatCompletionsRequest {
  model?: string;
  messages: OpenAIChatMessage[];
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  tools?: Array<{ type: 'function'; function: { name: string; description?: string; parameters?: unknown } }>;
  tool_choice?: 'auto' | 'none' | { type: 'function'; function: { name: string } };
  temperature?: number;
  max_tokens?: number;
  user?: string;
  metadata?: {
    sessionId?: string;
    userId?: string;
    conversation_id?: string;
    [key: string]: unknown;
  };
  call?: { id?: string; assistantId?: string; phoneNumber?: { number?: string } };
  phoneNumber?: unknown;
  customer?: unknown;
  elevenlabs_extra_body?: { conversation_id?: string; [key: string]: unknown };
  [key: string]: unknown;
}

interface OpenAIErrorBody {
  error: {
    message: string;
    type: string;
    param?: string | null;
    code?: string;
  };
}

interface ToolCallAccumulator {
  index: number;
  id: string;
  name: string;
  argsBuffer: string;
  nameSent: boolean;
  argsSentLength: number;
}

function openAIError(
  c: Context,
  status: 400 | 401 | 500,
  message: string,
  type: string,
  code?: string,
  param?: string | null,
) {
  const body: OpenAIErrorBody = {
    error: { message, type, ...(param !== undefined ? { param } : {}), ...(code ? { code } : {}) },
  };
  return c.json(body, status);
}

function validateBearerAuth(c: Context, apiKey?: string): Response | null {
  if (!apiKey) return null;
  const header = c.req.header('authorization');
  if (!header?.startsWith('Bearer ')) {
    return openAIError(c, 401, 'Incorrect API key provided', 'invalid_request_error', 'invalid_api_key');
  }
  const token = header.slice('Bearer '.length).trim();
  if (token !== apiKey) {
    return openAIError(c, 401, 'Incorrect API key provided', 'invalid_request_error', 'invalid_api_key');
  }
  return null;
}

function messageText(content: OpenAIChatMessage['content']): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((p) => p && typeof p === 'object' && p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text)
      .join(' ')
      .trim();
  }
  return '';
}

function extractLatestUserInput(messages: OpenAIChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === 'user') {
      const text = messageText(m.content);
      if (text) return text;
    }
  }
  return '';
}

function resolveSessionId(
  c: Context,
  body: ChatCompletionsRequest,
  sessionKey?: (req: Context) => string | undefined,
): string {
  const fromKey = sessionKey?.(c);
  if (fromKey) return fromKey;

  const elevenLabsId = body.elevenlabs_extra_body?.conversation_id;
  if (typeof elevenLabsId === 'string' && elevenLabsId) {
    return `el-${elevenLabsId}`;
  }

  if (body.call?.id) return `vapi-${body.call.id}`;

  if (typeof body.metadata?.sessionId === 'string' && body.metadata.sessionId) {
    return body.metadata.sessionId;
  }

  const systemText = body.messages.find((m) => m.role === 'system');
  const firstUser = body.messages.find((m) => m.role === 'user');
  const seed = `${messageText(systemText?.content ?? null)}|${messageText(firstUser?.content ?? null)}`;
  return 'oai-' + crypto.createHash('sha1').update(seed).digest('hex').slice(0, 16);
}

function resolveAgentId(body: ChatCompletionsRequest, configuredAgentId?: string): string | undefined {
  if (configuredAgentId) return configuredAgentId;
  if (typeof body.model === 'string' && body.model && body.model !== 'kuralle') {
    return body.model;
  }
  return undefined;
}

function toModelMessages(
  messages: OpenAIChatMessage[],
  systemPromptMode: SystemPromptMode,
): ModelMessage[] {
  const out: ModelMessage[] = [];
  for (const msg of messages) {
    if (msg.role === 'system') {
      if (systemPromptMode === 'agent') continue;
      const text = messageText(msg.content);
      if (text) out.push({ role: 'system', content: text });
      continue;
    }
    if (msg.role === 'user') {
      const text = messageText(msg.content);
      if (text) out.push({ role: 'user', content: text });
      continue;
    }
    if (msg.role === 'assistant') {
      const text = messageText(msg.content);
      if (text) {
        out.push({ role: 'assistant', content: text });
      } else if (msg.tool_calls?.length) {
        out.push({
          role: 'assistant',
          content: msg.tool_calls.map((tc) => ({
            type: 'tool-call' as const,
            toolCallId: tc.id,
            toolName: tc.function.name,
            input: safeParseJson(tc.function.arguments),
          })),
        });
      }
      continue;
    }
    if (msg.role === 'tool') {
      const text = messageText(msg.content);
      out.push({
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: msg.tool_call_id ?? 'unknown',
            toolName: msg.name ?? 'tool',
            output: { type: 'json', value: safeParseJson(text) as import('ai').JSONValue },
          },
        ],
      });
    }
  }
  return out;
}

function safeParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function buildPriorModelMessages(
  messages: OpenAIChatMessage[],
  systemPromptMode: SystemPromptMode,
): ModelMessage[] {
  let lastUserIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user' && messageText(messages[i]!.content)) {
      lastUserIndex = i;
      break;
    }
  }
  if (lastUserIndex <= 0) return [];
  return toModelMessages(messages.slice(0, lastUserIndex), systemPromptMode);
}

function buildSeedMessages(
  messages: OpenAIChatMessage[],
  systemPromptMode: SystemPromptMode,
): ModelMessage[] | undefined {
  const prior = buildPriorModelMessages(messages, systemPromptMode);
  return prior.length > 0 ? prior : undefined;
}

async function resolveHistoryDelta(
  runtime: RuntimeLike,
  sessionId: string,
  messages: OpenAIChatMessage[],
  systemPromptMode: SystemPromptMode,
  isNewSession: boolean,
): Promise<ModelMessage[] | undefined> {
  if (isNewSession) return undefined;
  const prior = buildPriorModelMessages(messages, systemPromptMode);
  const existingLen = (await runtime.getConversationLength?.(sessionId)) ?? 0;
  if (prior.length <= existingLen) return undefined;
  return prior.slice(existingLen);
}

function makeChatCompletionId(): string {
  return 'chatcmpl-' + crypto.randomBytes(12).toString('base64url');
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function estimateUsage(
  requestMessages: OpenAIChatMessage[],
  completionText: string,
): { prompt_tokens: number; completion_tokens: number; total_tokens: number } {
  const promptText = requestMessages.map((m) => messageText(m.content)).join('\n');
  const prompt_tokens = estimateTokens(promptText);
  const completion_tokens = estimateTokens(completionText);
  return { prompt_tokens, completion_tokens, total_tokens: prompt_tokens + completion_tokens };
}

async function collectTurn(
  handle: TurnHandle,
  clientTools: Set<string>,
): Promise<{
  text: string;
  toolCalls: ToolCallAccumulator[];
  finishReason: 'stop' | 'tool_calls';
}> {
  let text = '';
  const toolCalls: ToolCallAccumulator[] = [];
  let finishReason: 'stop' | 'tool_calls' = 'stop';
  let stopEarly = false;

  for await (const part of handle.events) {
    if (stopEarly) continue;
    if (part.type === 'text-delta') {
      text += part.text;
    } else if (part.type === 'tool-call') {
      if (!clientTools.has(part.toolName)) continue;
      const argsStr = typeof part.args === 'string' ? part.args : JSON.stringify(part.args ?? {});
      toolCalls.push({
        index: toolCalls.length,
        id: part.toolCallId ?? `call_${crypto.randomBytes(6).toString('hex')}`,
        name: part.toolName,
        argsBuffer: argsStr,
        nameSent: false,
        argsSentLength: 0,
      });
      finishReason = 'tool_calls';
      stopEarly = true;
    }
  }

  await handle.catch(() => {});
  return { text, toolCalls, finishReason };
}

function toolCallToOpenAI(tc: ToolCallAccumulator) {
  return {
    id: tc.id,
    type: 'function' as const,
    function: { name: tc.name, arguments: tc.argsBuffer },
  };
}

async function emitToolCallDeltas(
  writeChunk: (delta: Record<string, unknown>, finishReason?: string | null) => Promise<void>,
  tc: ToolCallAccumulator,
) {
  if (!tc.nameSent) {
    await writeChunk({
      tool_calls: [
        {
          index: tc.index,
          id: tc.id,
          type: 'function',
          function: { name: tc.name },
        },
      ],
    });
    tc.nameSent = true;
  }

  const chunkSize = 8;
  while (tc.argsSentLength < tc.argsBuffer.length) {
    const fragment = tc.argsBuffer.slice(tc.argsSentLength, tc.argsSentLength + chunkSize);
    tc.argsSentLength += fragment.length;
    await writeChunk({
      tool_calls: [{ index: tc.index, function: { arguments: fragment } }],
    });
  }
}

async function handleChatCompletions(
  c: Context,
  body: ChatCompletionsRequest,
  opts: CreateOpenAICompatRouterOptions,
) {
  const authError = validateBearerAuth(c, opts.apiKey);
  if (authError) return authError;

  if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
    return openAIError(c, 400, 'messages: array required and must not be empty', 'invalid_request_error', 'invalid_value', 'messages');
  }

  const systemPromptMode = opts.systemPromptMode ?? 'agent';
  const sessionId = resolveSessionId(c, body, opts.sessionKey);
  const input = extractLatestUserInput(body.messages);
  if (!input) {
    return openAIError(c, 400, 'No user message found in messages[]', 'invalid_request_error', 'no_user_message', 'messages');
  }

  const existingSession = await opts.runtime.getSession(sessionId);
  const isNewSession = !existingSession;
  const seedMessages = isNewSession ? buildSeedMessages(body.messages, systemPromptMode) : undefined;
  const historyDelta = await resolveHistoryDelta(
    opts.runtime,
    sessionId,
    body.messages,
    systemPromptMode,
    isNewSession,
  );
  const agentId = resolveAgentId(body, opts.agentId);
  const clientToolSet = new Set(opts.clientTools ?? []);
  const modelName = typeof body.model === 'string' && body.model ? body.model : 'kuralle';
  const completionId = makeChatCompletionId();
  const created = Math.floor(Date.now() / 1000);
  const includeUsage = body.stream_options?.include_usage === true;

  const handle = opts.runtime.run({
    sessionId,
    input,
    userId: typeof body.user === 'string' ? body.user : undefined,
    agentId,
    seedMessages,
    historyDelta,
  });

  if (body.stream === true) {
    return streamSSE(c, async (stream) => {
    const baseChunk = {
      id: completionId,
      object: 'chat.completion.chunk' as const,
      created,
      model: modelName,
    };

    const writeChunk = async (delta: Record<string, unknown>, finishReason: string | null = null) => {
      await stream.writeSSE({
        data: JSON.stringify({
          ...baseChunk,
          choices: [{ index: 0, delta, finish_reason: finishReason }],
        }),
      });
    };

    await writeChunk({ role: 'assistant' });

    let completionText = '';
    let finishReason: 'stop' | 'tool_calls' = 'stop';
    const pendingToolCalls: ToolCallAccumulator[] = [];
    let stopEarly = false;

    try {
      for await (const part of handle.events) {
        if (stopEarly) continue;
        if (part.type === 'text-delta') {
          if (!part.text) continue;
          completionText += part.text;
          await writeChunk({ content: part.text });
        } else if (part.type === 'tool-call') {
          if (!clientToolSet.has(part.toolName)) continue;
          const argsStr = typeof part.args === 'string' ? part.args : JSON.stringify(part.args ?? {});
          const acc: ToolCallAccumulator = {
            index: pendingToolCalls.length,
            id: part.toolCallId ?? `call_${crypto.randomBytes(6).toString('hex')}`,
            name: part.toolName,
            argsBuffer: argsStr,
            nameSent: false,
            argsSentLength: 0,
          };
          pendingToolCalls.push(acc);
          finishReason = 'tool_calls';
          await emitToolCallDeltas(writeChunk, acc);
          stopEarly = true;
        }
      }
    } catch (err) {
      await handle.catch(() => {});
      await writeChunk({}, 'stop');
      if (includeUsage) {
        const usage = estimateUsage(body.messages, completionText);
        await stream.writeSSE({
          data: JSON.stringify({
            ...baseChunk,
            choices: [],
            usage,
          }),
        });
      }
      await stream.writeSSE({ data: '[DONE]' });
      return;
    }

    await handle.catch(() => {});

    await writeChunk({}, finishReason);

    if (includeUsage) {
      const usage = estimateUsage(body.messages, completionText);
      await stream.writeSSE({
        data: JSON.stringify({
          ...baseChunk,
          choices: [],
          usage,
        }),
      });
    }

    await stream.writeSSE({ data: '[DONE]' });
    });
  }

  const { text, toolCalls, finishReason } = await collectTurn(handle, clientToolSet);
  const usage = estimateUsage(body.messages, text);
  return c.json({
    id: completionId,
    object: 'chat.completion',
    created,
    model: modelName,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: text || null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls.map(toolCallToOpenAI) } : {}),
        },
        finish_reason: finishReason,
      },
    ],
    usage,
  });
}

function createChatCompletionsApp(opts: CreateOpenAICompatRouterOptions): Hono {
  const app = new Hono();

  const handler = async (c: Context) => {
    let body: ChatCompletionsRequest;
    try {
      body = (await c.req.json()) as ChatCompletionsRequest;
    } catch {
      return openAIError(c, 400, 'Invalid JSON body', 'invalid_request_error', 'invalid_json');
    }
    return handleChatCompletions(c, body, opts);
  };

  app.post('/v1/chat/completions', handler);
  app.post('/chat/completions', handler);
  return app;
}

export function createOpenAICompatRouter(opts: CreateOpenAICompatRouterOptions): Hono {
  return createChatCompletionsApp(opts);
}

export type { RuntimeLike as OpenAICompatRuntime } from '@kuralle-agents/core';
