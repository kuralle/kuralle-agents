import type { AgentStreamPart } from '../types/index.js';
import { getChunkArgs, getChunkResult, getChunkToolCallId, getChunkErrorMessage } from './streamChunk.js';
import { isHandoffResult } from '../tools/handoff.js';

interface AIStreamChunk {
  type: string;
  text?: string;
  toolName?: string;
}

function asAIStreamChunk(value: unknown): AIStreamChunk | null {
  if (typeof value !== 'object' || value === null) return null;
  return value as AIStreamChunk;
}

/**
 * Processes a stream from the AI SDK and yields canonical AgentStreamParts.
 * Shared stream-iteration helper for model calls.
 */
export async function* processAIStream(
    stream: AsyncIterable<unknown>
): AsyncGenerator<AgentStreamPart> {
    for await (const raw of stream) {
        const chunk = asAIStreamChunk(raw);
        if (!chunk) continue;
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
            yield { type: 'text-delta', text: chunk.text };
        }

        if (chunk.type === 'tool-call' && chunk.toolName) {
            const args = getChunkArgs(chunk);
            const toolCallId = getChunkToolCallId(chunk);
            yield { type: 'tool-call', toolName: chunk.toolName, args, toolCallId };
        }

        if (chunk.type === 'tool-result' && chunk.toolName) {
            const toolResult = getChunkResult(chunk);
            const toolCallId = getChunkToolCallId(chunk);
            yield { type: 'tool-result', toolName: chunk.toolName, result: toolResult, toolCallId };

            if (isHandoffResult(toolResult)) {
                const targetAgent = toolResult.targetAgent ?? toolResult.targetAgentId;
                yield {
                    type: 'handoff',
                    targetAgent,
                    reason: toolResult.reason,
                };
            }
        }

        if (chunk.type === 'tool-error' && chunk.toolName) {
            const toolCallId = getChunkToolCallId(chunk);
            const error = getChunkErrorMessage(chunk);
            yield { type: 'tool-error', toolName: chunk.toolName, error, toolCallId };
        }

        if (chunk.type === 'error') {
            const error = getChunkErrorMessage(chunk);
            yield { type: 'error', error };
        }
    }
}
