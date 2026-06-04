import type { HarnessStreamPart } from '@kuralle-agents/core';
import type { StreamAdapterConfig } from './types.js';
import { DEFAULT_STREAM_CONFIG } from './types.js';

/**
 * Convert Kuralle's HarnessStreamPart generator into an SSE Response
 * that CF's AIChatAgent._reply() can parse.
 *
 * CF's _streamSSEReply reads lines in the format:
 *   data: {"type":"text-start"}\n\n
 *   data: {"type":"text-delta","delta":"Hello"}\n\n
 *   data: {"type":"tool-input-available","toolCallId":"...","toolName":"...","input":{...}}\n\n
 *   data: {"type":"tool-output-available","toolCallId":"...","output":{...}}\n\n
 *   data: {"type":"data-handoff","data":{...}}\n\n
 *   data: {"type":"text-end"}\n\n
 *
 * CF's applyChunkToParts() then builds UIMessage parts from these chunks.
 * CF handles persistence, broadcasting, and resumability.
 */
export function createSSEResponse(
  stream: AsyncGenerator<HarnessStreamPart>,
  config: StreamAdapterConfig = DEFAULT_STREAM_CONFIG,
): Response {
  const encoder = new TextEncoder();
  let textStarted = false;

  const body = new ReadableStream({
    async start(controller) {
      try {
        for await (const part of stream) {
          const lines = convertToSSELines(part, config, textStarted);

          for (const line of lines) {
            // Track whether we've emitted text-start
            if (line.includes('"text-start"')) textStarted = true;
            if (line.includes('"text-end"')) textStarted = false;

            controller.enqueue(encoder.encode(line));
          }
        }

        // Ensure text is closed if still open
        if (textStarted) {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ type: 'text-end' })}\n\n`),
          );
        }

        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });

  return new Response(body, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
    },
  });
}

/**
 * Convert a single HarnessStreamPart to SSE data lines.
 * Returns 0+ formatted SSE lines ("data: {...}\n\n").
 */
function convertToSSELines(
  part: HarnessStreamPart,
  config: StreamAdapterConfig,
  textStarted: boolean,
): string[] {
  const lines: string[] = [];
  const sse = (obj: Record<string, unknown>) =>
    `data: ${JSON.stringify(obj)}\n\n`;

  switch (part.type) {
    case 'text-delta': {
      // Emit text-start on first text chunk
      if (!textStarted) {
        lines.push(sse({ type: 'text-start' }));
      }
      lines.push(sse({ type: 'text-delta', delta: part.delta }));
      break;
    }

    case 'tool-call': {
      // Close text before tool if open
      if (textStarted) {
        lines.push(sse({ type: 'text-end' }));
      }
      // CF expects tool-input-available with toolCallId, toolName, input
      lines.push(sse({
        type: 'tool-input-available',
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        input: config.includeToolArgs ? part.args : undefined,
      }));
      break;
    }

    case 'tool-result': {
      lines.push(sse({
        type: 'tool-output-available',
        toolCallId: part.toolCallId,
        output: part.result,
      }));
      break;
    }

    case 'handoff': {
      if (!config.includeHandoffs) break;
      lines.push(sse({
        type: 'data-handoff',
        data: {
          to: part.targetAgent,
          reason: part.reason,
        },
      }));
      break;
    }

    case 'flow-enter': {
      if (!config.includeFlowEvents) break;
      lines.push(sse({
        type: 'data-flow-enter',
        data: { flow: part.flow },
      }));
      break;
    }

    case 'node-enter': {
      if (!config.includeFlowEvents) break;
      lines.push(sse({
        type: 'data-flow-node',
        data: { node: part.nodeName, event: 'enter' },
      }));
      break;
    }

    case 'node-exit': {
      if (!config.includeFlowEvents) break;
      lines.push(sse({
        type: 'data-flow-node',
        data: { node: part.nodeName, event: 'exit' },
      }));
      break;
    }

    case 'flow-transition': {
      if (!config.includeFlowEvents) break;
      lines.push(sse({
        type: 'data-flow-transition',
        data: { from: part.from, to: part.to },
      }));
      break;
    }

    case 'flow-end': {
      if (!config.includeFlowEvents) break;
      lines.push(sse({
        type: 'data-flow-end',
        data: { reason: part.reason },
      }));
      break;
    }

    case 'error': {
      lines.push(sse({
        type: 'data-error',
        data: { error: part.error },
      }));
      break;
    }

    case 'done':
      // CF handles stream completion via ReadableStream close.
      // The 'done' event is Kuralle-internal. Don't emit it.
      break;

    case 'interrupted':
    case 'paused':
    case 'conversation-outcome':
    case 'turn-end':
      break;
  }

  return lines;
}
