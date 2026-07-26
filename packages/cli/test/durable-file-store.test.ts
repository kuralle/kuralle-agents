import { describe, expect, it } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { createRuntime, defineAgent, defineTool } from '@kuralle-agents/core';
import type { StreamPart } from '@kuralle-agents/core';
import { z } from 'zod';
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
 * The invariant, tested directly.
 *
 * Reproducing the race itself proved unreliable — four separate loops (bare ctx, Runtime +
 * MemoryStore, Runtime + a no-CAS stub, Runtime + this file store, all with parallel
 * `replay:false` tools) stayed green while the live agent failed 3/3. Asserting the symptom
 * would have given false confidence. So assert the contract the runtime actually depends on:
 * a stale write must be rejected, because `mutateSessionWithRetry` retries on exactly that
 * and silently loses the append otherwise.
 */
describe('test:file-store-cas', () => {
  it('rejects a stale write instead of silently overwriting', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'kuralle-cas-')), 'sessions.json');
    const store = fileSessionStore(path);

    const base = {
      id: 's1', conversationId: 's1', channelId: 'test',
      createdAt: new Date(), updatedAt: new Date(),
      messages: [], workingMemory: {}, currentAgent: 'a',
      agentStates: {}, handoffHistory: [], version: 0,
    } as never;

    await store.save(base);
    const a = (await store.get('s1'))!;
    const b = (await store.get('s1'))!;   // second reader at the same version

    await store.save({ ...a, currentAgent: 'from-a' } as never);

    // b is now stale. Accepting this write is what loses a journal append.
    await expect(store.save({ ...b, currentAgent: 'from-b' } as never)).rejects.toThrow(
      /stale|version/i,
    );

    const final = await store.get('s1');
    expect(final?.currentAgent).toBe('from-a');   // first write survives
    expect(final?.version).toBe(2);               // and the version advanced exactly once
  });
});
