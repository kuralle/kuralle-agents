import type { ModelMessage } from 'ai';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function getTextFromParts(parts: unknown[]): string {
  return parts
    .map(part => {
      if (!isRecord(part) || part.type !== 'text') {
        return '';
      }
      return typeof part.text === 'string' ? part.text : '';
    })
    .join('')
    .trim();
}

/**
 * Extract provider metadata fields from a part if present.
 * Gemini thinking models require `providerMetadata.google.thoughtSignature`
 * to be preserved on tool-call and reasoning parts. Stripping it causes
 * "Function call is missing a thought_signature" errors on subsequent turns.
 */
function extractProviderFields(part: Record<string, unknown>): Record<string, unknown> {
  const extra: Record<string, unknown> = {};
  if (isRecord(part.providerMetadata)) extra.providerMetadata = part.providerMetadata;
  if (isRecord(part.providerOptions)) extra.providerOptions = part.providerOptions;
  return extra;
}

function normalizeToolParts(parts: unknown[]): Array<Record<string, unknown>> {
  const normalized: Array<Record<string, unknown>> = [];

  for (const part of parts) {
    if (!isRecord(part) || typeof part.type !== 'string') {
      continue;
    }

    if (part.type === 'tool-result') {
      if (
        typeof part.toolCallId === 'string' &&
        typeof part.toolName === 'string' &&
        'output' in part
      ) {
        normalized.push({
          type: 'tool-result',
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          output: part.output,
          ...extractProviderFields(part),
        });
      }
      continue;
    }

    if (part.type === 'tool-approval-response') {
      if (typeof part.approvalId === 'string' && typeof part.approved === 'boolean') {
        normalized.push({
          type: 'tool-approval-response',
          approvalId: part.approvalId,
          approved: part.approved,
          ...(typeof part.reason === 'string' ? { reason: part.reason } : {}),
          ...(typeof part.providerExecuted === 'boolean'
            ? { providerExecuted: part.providerExecuted }
            : {}),
        });
      }
    }
  }

  return normalized;
}

function normalizeAssistantParts(parts: unknown[]): Array<Record<string, unknown>> {
  const normalized: Array<Record<string, unknown>> = [];

  for (const part of parts) {
    if (!isRecord(part) || typeof part.type !== 'string') {
      continue;
    }

    if (part.type === 'text') {
      if (typeof part.text === 'string') {
        normalized.push({ type: 'text', text: part.text, ...extractProviderFields(part) });
      }
      continue;
    }

    if (part.type === 'tool-call') {
      if (
        typeof part.toolCallId === 'string' &&
        typeof part.toolName === 'string' &&
        'input' in part
      ) {
        normalized.push({
          type: 'tool-call',
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          input: part.input,
          ...extractProviderFields(part),
        });
      }
      continue;
    }

    if (part.type === 'tool-result') {
      if (
        typeof part.toolCallId === 'string' &&
        typeof part.toolName === 'string' &&
        'output' in part
      ) {
        normalized.push({
          type: 'tool-result',
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          output: part.output,
          ...extractProviderFields(part),
        });
      }
      continue;
    }

    if (part.type === 'reasoning' && typeof part.text === 'string') {
      normalized.push({ type: 'reasoning', text: part.text, ...extractProviderFields(part) });
    }
  }

  return normalized;
}

export function normalizeModelMessage(message: ModelMessage): ModelMessage | null {
  const role = message.role;
  const content = (message as { content: unknown }).content;

  if (typeof content === 'string') {
    return message;
  }

  if (!Array.isArray(content)) {
    return null;
  }

  if (role === 'tool') {
    const toolParts = normalizeToolParts(content);
    if (toolParts.length === 0) {
      return null;
    }
    return { role: 'tool', content: toolParts } as ModelMessage;
  }

  if (role === 'assistant') {
    const assistantParts = normalizeAssistantParts(content);
    if (assistantParts.length > 0) {
      return { role: 'assistant', content: assistantParts } as ModelMessage;
    }

    const text = getTextFromParts(content);
    return text.length > 0 ? ({ role, content: text } as ModelMessage) : null;
  }

  const text = getTextFromParts(content);
  return text.length > 0 ? ({ role, content: text } as ModelMessage) : null;
}
