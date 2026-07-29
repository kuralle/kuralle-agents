import type {
  AssistantMessage,
  ThinkingContent,
  ToolCall,
  ImageContent,
  Message,
  TextContent,
  ToolResultMessage,
  Usage,
} from '@earendil-works/pi-ai';
import type { AssistantContent, ModelMessage } from 'ai';

const EMPTY_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function dataToBase64(data: string | Uint8Array): string | undefined {
  if (data instanceof Uint8Array) return Buffer.from(data).toString('base64');
  const match = /^data:[^;,]+;base64,(.*)$/s.exec(data);
  return match?.[1];
}

function userContent(content: ModelMessage['content']): string | Array<TextContent | ImageContent> {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return textOf(content);
  const out: Array<TextContent | ImageContent> = [];
  for (const part of content) {
    if (part.type === 'text') out.push({ type: 'text', text: part.text });
    if (part.type === 'image') {
      const encoded = dataToBase64(part.image as string | Uint8Array);
      if (encoded) out.push({ type: 'image', data: encoded, mimeType: part.mediaType ?? 'image/jpeg' });
      else out.push({ type: 'text', text: `[image: ${textOf(part.image)}]` });
    }
    if (part.type === 'file') {
      const encoded = dataToBase64(part.data as string | Uint8Array);
      if (encoded && part.mediaType.startsWith('image/')) {
        out.push({ type: 'image', data: encoded, mimeType: part.mediaType });
      } else {
        out.push({ type: 'text', text: `[file${part.filename ? ` ${part.filename}` : ''}: ${part.mediaType}]` });
      }
    }
  }
  return out.length > 0 ? out : '';
}

function assistantFromAi(message: Extract<ModelMessage, { role: 'assistant' }>): AssistantMessage {
  const content: Array<TextContent | ThinkingContent | ToolCall> = [];
  if (typeof message.content === 'string') {
    content.push({ type: 'text', text: message.content });
  } else {
    for (const part of message.content) {
      if (part.type === 'text') content.push({ type: 'text', text: part.text });
      if (part.type === 'reasoning') content.push({ type: 'thinking', thinking: part.text });
      if (part.type === 'tool-call') {
        content.push({
          type: 'toolCall',
          id: part.toolCallId,
          name: part.toolName,
          arguments: (part.input ?? {}) as Record<string, unknown>,
        });
      }
    }
  }
  return {
    role: 'assistant',
    content,
    api: 'kuralle-history',
    provider: 'kuralle',
    model: 'history',
    usage: emptyPiUsage(),
    stopReason: content.some((part) => part.type === 'toolCall') ? 'toolUse' : 'stop',
    timestamp: Date.now(),
  };
}

function toolResultsFromAi(message: Extract<ModelMessage, { role: 'tool' }>): ToolResultMessage[] {
  return message.content.flatMap((part) => {
    if (part.type !== 'tool-result') return [];
    const output = part.output;
    const isError = output.type === 'error-text' || output.type === 'error-json';
    const value = output.type === 'text' || output.type === 'error-text'
      ? output.value
      : output.type === 'json' || output.type === 'error-json'
        ? output.value
        : output;
    return [{
      role: 'toolResult',
      toolCallId: part.toolCallId,
      toolName: part.toolName,
      content: [{ type: 'text', text: textOf(value) }],
      details: value,
      isError,
      timestamp: Date.now(),
    }];
  });
}

export function aiMessagesToPi(messages: ModelMessage[]): Message[] {
  return messages.flatMap((message): Message[] => {
    if (message.role === 'user') {
      return [{ role: 'user', content: userContent(message.content), timestamp: Date.now() }];
    }
    if (message.role === 'assistant') return [assistantFromAi(message)];
    if (message.role === 'tool') return toolResultsFromAi(message);
    if (message.role === 'system') {
      return [{ role: 'user', content: `[system note]\n${textOf(message.content)}`, timestamp: Date.now() }];
    }
    return [];
  });
}

export function piAssistantToAi(message: AssistantMessage): ModelMessage {
  const content: AssistantContent = [];
  for (const part of message.content) {
    if (part.type === 'text') content.push({ type: 'text', text: part.text });
    else if (part.type === 'thinking') content.push({ type: 'reasoning', text: part.thinking });
    else {
      content.push({
        type: 'tool-call',
        toolCallId: part.id,
        toolName: part.name,
        input: part.arguments,
      });
    }
  }
  return {
    role: 'assistant',
    content,
  };
}

/** Preserve Pi-side validation/unknown-tool failures in Kuralle's AI SDK history. */
export function piToolResultToAi(message: ToolResultMessage): ModelMessage {
  const text = message.content
    .filter((part): part is TextContent => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
  return {
    role: 'tool',
    content: [{
      type: 'tool-result',
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      output: message.isError
        ? { type: 'error-text', value: text || 'Tool call failed validation.' }
        : { type: 'json', value: message.details as import('ai').JSONValue },
    }],
  };
}

export function emptyPiUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { ...EMPTY_COST },
  };
}
