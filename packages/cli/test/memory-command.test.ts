import { describe, expect, it } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LoggedEvent, StreamPart } from '@kuralle-agents/core';
import { createEventBus, createTurnHandle } from '../../../core/src/events/TurnHandle.js';
import { readLocalMemory } from '../src/agentMemory.js';
import { runMemory, watchMemoryEvents } from '../src/memory.js';
import { fileSessionEventLog } from '../src/fileEventLog.js';
import { runSend } from '../src/send.js';
import {
  agent,
  buildRuntime,
  extractedValueStore,
  tasteExtractor,
} from './fixtures/memory-fixture-agent.js';

const here = dirname(fileURLToPath(import.meta.url));
const memoryAgent = join(here, 'fixtures/memory-fixture-agent.ts');

function tmpEvents(): string {
  return join(mkdtempSync(join(tmpdir(), 'kuralle-memory-')), 'events.jsonl');
}

describe('memory command', () => {
  it('prints extracted slug for --user with one extractor', async () => {
    const owner = 'u1';
    await extractedValueStore.save(
      {
        slug: tasteExtractor.slug,
        scope: 'user',
        value: { foods: ['mint'] },
        updatedAt: new Date().toISOString(),
      },
      owner,
    );

    const outcome = await readLocalMemory({ agent, extractedValueStore }, owner);
    expect(outcome.status).toBe(200);
    const body = outcome.body as { extracted: Array<{ slug: string }> };
    expect(body.extracted.some((entry) => entry.slug === tasteExtractor.slug)).toBe(true);
  });

  it('--watch emits an extraction record after done', async () => {
    const path = tmpEvents();
    const eventLog = fileSessionEventLog(path);
    const sessionId = 'watch-sess';
    const runId = 'run-watch';

    const watchPromise = watchMemoryEvents(eventLog, sessionId, {
      idleAfterDoneMs: 300,
      onEvent: () => {},
    });
    await eventLog.append(sessionId, [
      { channel: 'client', type: 'done', payload: { sessionId } },
    ] as StreamPart[], runId);
    await eventLog.append(sessionId, [{
      channel: 'internal',
      type: 'extraction',
      payload: { slug: tasteExtractor.slug, value: { foods: ['basil'] }, changed: true },
    }] as StreamPart[], runId);

    const seen = await watchPromise;
    expect(seen.some((event) => event.part.type === 'extraction')).toBe(true);
  });

  it('runMemory --watch fails red gate when follow stops at done', async () => {
    const path = tmpEvents();
    const eventLog = fileSessionEventLog(path);
    const sessionId = 'redgate';
    const runId = 'run-red';

    async function stopAtDone(): Promise<LoggedEvent[]> {
      const from = (await eventLog.tail(sessionId)) + 1;
      const seen: LoggedEvent[] = [];
      for await (const event of eventLog.follow(sessionId, from)) {
        if (event.part.type === 'extraction') seen.push(event);
        if (event.part.type === 'done') break;
      }
      return seen;
    }

    const watchPromise = stopAtDone();
    await eventLog.append(sessionId, [
      { channel: 'client', type: 'done', payload: { sessionId } },
    ] as StreamPart[], runId);
    await eventLog.append(sessionId, [{
      channel: 'internal',
      type: 'extraction',
      payload: { slug: tasteExtractor.slug, value: { foods: ['late'] }, changed: true },
    }] as StreamPart[], runId);

    const seen = await watchPromise;
    expect(seen).toHaveLength(0);
  });

  it('CLI memory stdout is JSON without ANSI', async () => {
    const owner = 'u-cli';
    await extractedValueStore.save(
      {
        slug: tasteExtractor.slug,
        scope: 'user',
        value: { foods: ['thyme'] },
        updatedAt: new Date().toISOString(),
      },
      owner,
    );

    const chunks: string[] = [];
    const stdout = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

    try {
      await runMemory(['--user', owner, '--agent', memoryAgent], buildRuntime, memoryAgent);
    } finally {
      process.stdout.write = stdout;
    }

    const parsed = JSON.parse(chunks.join('').trim()) as { extracted: Array<{ slug: string }> };
    expect(parsed.extracted.some((entry) => entry.slug === tasteExtractor.slug)).toBe(true);
    expect(chunks.join('')).not.toMatch(/\x1b\[/);
  });
});

/**
 * `kuralle send` is one turn per process, so the process boundary IS the turn boundary.
 *
 * Extraction runs as background work by default — a design that assumes a long-lived host. Under
 * the CLI the process exits first and the fact is lost with no error and no warning. Measured on a
 * live run before the fix: a turn that named two allergens wrote zero files to the extracted-value
 * store; with `runtime.settled()` awaited, one.
 *
 * The other tests in this file seed the store directly and read it back, so the runtime's own
 * write path was never crossed and this was invisible to all of them.
 */
describe('send settles background extraction before the process can exit', () => {
  it('an extracted value is durable by the time runSend resolves', async () => {
    const store = join(mkdtempSync(join(tmpdir(), 'kuralle-extract-')), 'sessions.json');
    const { buildRuntime, extractedValueStore: slowStore } = await import('./fixtures/extraction-agent.js');

    await runSend(
      ['--session', 'extract', '--user', 'mithushan', '--store', store, 'a pot of tea please'],
      buildRuntime,
    );

    expect(await slowStore.load('user', 'mithushan', 'drink')).not.toBeNull();
  });
});
