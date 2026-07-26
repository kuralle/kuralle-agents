/**
 * `resume` wiring — verified without a model or network.
 *
 * Asserts the command parses `<session>` / `--store` / `--summary`, hands the runtime a
 * file-backed session + trace store, and calls `resumeFromEscalation` with the resolved
 * summary (or undefined when omitted). Mirrors the store-wiring contract tests for `send`.
 */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionStore, TraceStore } from '@kuralle-agents/core';
import { runResume } from '../src/resume.js';

function tmpStore(name = 'sessions.json'): string {
  return join(mkdtempSync(join(tmpdir(), 'kuralle-cli-')), name);
}

function recordingBuildRuntime() {
  const seen: { sessionId?: string; store?: SessionStore; traceStore?: TraceStore } = {};
  const resumed: { sessionId?: string; summary?: string | undefined } = {};
  const runtime = {
    resumeFromEscalation: async (sessionId: string, opts?: { resolutionSummary?: string }) => {
      resumed.sessionId = sessionId;
      resumed.summary = opts?.resolutionSummary;
    },
  };
  const build = (sessionId?: string, store?: SessionStore, traceStore?: TraceStore) => {
    seen.sessionId = sessionId;
    seen.store = store;
    seen.traceStore = traceStore;
    return { runtime } as never;
  };
  return { seen, resumed, build };
}

describe('test:cli-resume-wiring', () => {
  it('parses <session> positional + --store, and calls resumeFromEscalation', async () => {
    const path = tmpStore();
    const { seen, resumed, build } = recordingBuildRuntime();

    await runResume(['demo', '--store', path], build);

    expect(seen.sessionId).toBe('demo');
    expect(seen.store).toBeDefined();
    expect(seen.traceStore).toBeDefined();
    expect(resumed.sessionId).toBe('demo');
    expect(resumed.summary).toBeUndefined();
  });

  it('forwards --summary to resumeFromEscalation as resolutionSummary', async () => {
    const path = tmpStore();
    const { resumed, build } = recordingBuildRuntime();

    await runResume(['demo', '--store', path, '--summary', 'Refund issued for order #42.'], build);

    expect(resumed.sessionId).toBe('demo');
    expect(resumed.summary).toBe('Refund issued for order #42.');
  });

  it('hands the runtime a file-backed trace store beside --store (same contract as send)', async () => {
    const path = tmpStore('res.json');
    const { seen, build } = recordingBuildRuntime();
    await runResume(['demo', '--store', path], build);

    expect(seen.traceStore).toBeDefined();
    // fileTraceStore is lazy — confirm the store resolves to the sidecar path by writing.
    seen.traceStore!.write({
      traceId: 't1', spanId: 's1', name: 'turn', kind: 'turn',
      startTime: 1, endTime: 2, attributes: { sessionId: 'demo' },
    } as never);
    const sidecar = path.replace(/\.json$/, '') + '.traces.json';
    expect(existsSync(sidecar)).toBe(true);
  });
});
