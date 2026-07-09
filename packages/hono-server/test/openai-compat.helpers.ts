import type { HarnessStreamPart, RunOptions, RuntimeLike } from '@kuralle-agents/core';
import { createMockRuntime, type MockRuntimeRunCall } from '@kuralle-agents/core/testing';
import type { Session } from '@kuralle-agents/core';

export type RecordedRun = MockRuntimeRunCall;

export function mockRuntime(
  parts: HarnessStreamPart[],
  options: {
    sessions?: Map<string, Session>;
    onRun?: (call: RecordedRun) => void;
  } = {},
): RuntimeLike {
  return createMockRuntime(parts, options);
}

export async function parseOpenAiSse(body: string): Promise<Array<Record<string, unknown> | string>> {
  const chunks: Array<Record<string, unknown> | string> = [];
  for (const block of body.split('\n\n')) {
    const line = block.trim();
    if (!line.startsWith('data: ')) continue;
    const raw = line.slice('data: '.length);
    if (raw === '[DONE]') {
      chunks.push('[DONE]');
    } else {
      chunks.push(JSON.parse(raw) as Record<string, unknown>);
    }
  }
  return chunks;
}

export type { RunOptions };
