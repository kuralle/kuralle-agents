import { describe, expect, it } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { createRuntime, defineAgent, defineTool } from '@kuralle-agents/core';
import type { StreamPart } from '@kuralle-agents/core';
import { z } from 'zod';
import {
  runSessionStoreCasContract,
  runSessionStoreContract,
} from '@kuralle-agents/core/session/testing';
import { fileSessionStore } from '../src/fileStore.js';

/**
 * The live `StepNotFoundError` reproduces through `kuralle send` (3/3) but not through a
 * Runtime backed by `MemoryStore`. The difference under test here is the CLI's own store:
 *
 *   MemoryStore.save     — compare-and-swap; throws StaleWriteError on a version mismatch,
 *                          which is what mutateSessionWithRetry retries against.
 *   fileSessionStore.save — readAll / mutate / writeAll. No version check at all.
 *
 * An effect journal needs an atomic conditional write. A store that silently accepts a
 * stale write can lose an appended step, and the step's finalize then has nothing to find.
 */

function batchThenText(toolNames: string[]) {
  let call = 0;
  return new MockLanguageModelV3({
    doStream: async () => {
      call += 1;
      if (call === 1) {
        return {
          stream: simulateReadableStream({
            chunks: [
              ...toolNames.map((name, i) => ({
                type: 'tool-call' as const,
                toolCallId: `tc-${call}-${i}`,
                toolName: name,
                input: JSON.stringify({ q: name }),
              })),
              {
                type: 'finish' as const,
                finishReason: 'tool-calls' as const,
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              },
            ],
          }),
        };
      }
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: 'text-start' as const, id: '1' },
            { type: 'text-delta' as const, id: '1', delta: 'ok' },
            { type: 'text-end' as const, id: '1' },
            {
              type: 'finish' as const,
              finishReason: 'stop' as const,
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            },
          ],
        }),
      };
    },
  });
}

const read = (name: string) =>
  defineTool({
    name,
    description: `Read ${name}`,
    replay: false,
    parallelSafe: true,
    input: z.object({ q: z.string().optional() }),
    execute: async () => {
      await new Promise((r) => setTimeout(r, 3));
      return { name, ok: true };
    },
  });

async function drain(handle: { events: AsyncIterable<StreamPart> }): Promise<string[]> {
  const errors: string[] = [];
  for await (const p of handle.events) {
    if (p.type === 'error') errors.push(p.payload.error);
  }
  return errors;
}

describe('test:durable-file-store', () => {
  it('does not lose journal steps when parallel replay:false tools run over the file store', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'kuralle-dur-')), 'sessions.json');
    const names = ['read_a', 'read_b', 'read_c'];
    const runtime = createRuntime({
      agents: [
        defineAgent({
          id: 'probe',
          instructions: 'Call the read tools.',
          model: batchThenText(names),
          globalTools: Object.fromEntries(names.map((n) => [n, read(n)])),
        }),
      ],
      defaultAgentId: 'probe',
      sessionStore: fileSessionStore(path),
    });

    const seen: string[] = [];
    for (let turn = 0; turn < 5; turn += 1) {
      seen.push(...(await drain(runtime.run({ sessionId: 'probe', input: `turn ${turn}` }))));
    }

    expect(seen.filter((e) => e.includes('Step not found'))).toEqual([]);
  });
});

/**
 * The shared contract, run against the CLI's file store.
 *
 * `runSessionStoreContract` / `runSessionStoreCasContract` have existed in core all along,
 * and MemoryStore, PostgresSessionStore and RedisSessionStore all run them. This store was
 * added later, in a different package, and never adopted them — which is exactly why its
 * missing compare-and-swap shipped. A store that backs the durable journal must pass the
 * same battery as every other one.
 */
runSessionStoreContract(() => fileSessionStore(join(mkdtempSync(join(tmpdir(), 'kuralle-c1-')), 's.json')));
runSessionStoreCasContract(() => fileSessionStore(join(mkdtempSync(join(tmpdir(), 'kuralle-c2-')), 's.json')));
