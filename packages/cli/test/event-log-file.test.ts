/**
 * Cross-process durability for the CLI's file-backed SessionEventLog.
 *
 * `send` is one turn per process, so an in-process test proves nothing — the log must
 * survive a fresh process reading from index 0.
 */
import { describe, expect, it } from 'bun:test';
import { appendFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StreamPart } from '@kuralle-agents/core';
import { fileSessionEventLog } from '../src/fileEventLog.js';

const worker = join(import.meta.dir, 'fixtures/event-log-worker.ts');

function tmpLog(name = 'events.jsonl'): string {
  return join(mkdtempSync(join(tmpdir(), 'kuralle-cli-el-')), name);
}

function turnEnd(): StreamPart {
  return { channel: 'internal', type: 'turn-end', payload: {} };
}

async function spawnWorker(path: string, mode: 'write-first' | 'write-second'): Promise<number> {
  const proc = Bun.spawn(['bun', worker, path, mode], { stdout: 'ignore', stderr: 'pipe' });
  return proc.exited;
}

describe('test:cli-event-log-file', () => {
  it('a log written by one process is read from index 0 by a second process', async () => {
    const path = tmpLog();
    expect(await spawnWorker(path, 'write-first')).toBe(0);

    const reader = fileSessionEventLog(path);
    const { events } = await reader.read('cross-sess', 0);
    expect(events).toHaveLength(1);
    expect(events[0]!.index).toBe(0);
    expect(events[0]!.runId).toBe('run-1');
  });

  it('indices survive reopen: append, close, reopen, append', async () => {
    const path = tmpLog();
    expect(await spawnWorker(path, 'write-first')).toBe(0);

    const reopened = fileSessionEventLog(path);
    await reopened.append('cross-sess', [turnEnd(), turnEnd()], 'run-2');

    const { events } = await reopened.read('cross-sess', 0);
    expect(events.map((event) => event.index)).toEqual([0, 1, 2]);
    expect(await reopened.tail('cross-sess')).toBe(2);
  });

  it('a torn final line does not fail the read', async () => {
    const path = tmpLog();
    const log = fileSessionEventLog(path);
    await log.append('demo', [turnEnd()], 'run-1');
    appendFileSync(path, '{"sessionId":"demo","index":1,"eventId":"partial"');

    const { events } = await fileSessionEventLog(path).read('demo', 0);
    expect(events).toHaveLength(1);
    expect(events[0]!.index).toBe(0);
  });
});
