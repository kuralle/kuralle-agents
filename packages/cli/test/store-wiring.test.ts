/**
 * The CLI's store wiring, tested without a model or a network call.
 *
 * `send --store` shipped persisting the session but *discarding* every trace: it called
 * `buildRuntime(sessionId, store)` with no third argument, and `agentLoader.defaultStores`
 * falls back to `MemoryTraceStore` whenever a session store is supplied. Since `send` is one
 * turn per process, the traces died on exit and `kuralle trace --store` reported "No traces
 * found" — while the CLI guide documented the opposite.
 *
 * Nothing caught it because `packages/cli` had no tests at all. These assert the wiring
 * contract directly: which stores each command hands the runtime, and that they are
 * file-backed. No API key required, so this runs in any environment.
 */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionStore, TraceStore, AgentSpan } from '@kuralle-agents/core';
import { runSend } from '../src/send.js';
import { fileTraceStore } from '../src/fileTraceStore.js';

function tmpStore(name = 'sessions.json'): string {
  return join(mkdtempSync(join(tmpdir(), 'kuralle-cli-')), name);
}

/** Captures what the CLI hands the runtime, and answers `--state` without a model. */
function recordingBuildRuntime() {
  const seen: { sessionId?: string; store?: SessionStore; traceStore?: TraceStore } = {};
  const build = (sessionId?: string, store?: SessionStore, traceStore?: TraceStore) => {
    seen.sessionId = sessionId;
    seen.store = store;
    seen.traceStore = traceStore;
    return { runtime: { run: () => { throw new Error('no model in this test'); } } } as never;
  };
  return { seen, build };
}

describe('test:cli-store-wiring', () => {
  it('send passes a trace store, not just a session store', async () => {
    const path = tmpStore();
    const { seen, build } = recordingBuildRuntime();

    await runSend(['--session', 'demo', '--store', path, '--state'], build);

    expect(seen.sessionId).toBe('demo');
    expect(seen.store).toBeDefined();
    // The regression: this was undefined, so the loader silently substituted memory.
    expect(seen.traceStore).toBeDefined();
  });

  it("send's trace store writes to the sidecar beside --store, and survives the process", async () => {
    const path = tmpStore('okf.json');
    const { seen, build } = recordingBuildRuntime();
    await runSend(['--session', 'demo', '--store', path, '--state'], build);

    const span: AgentSpan = {
      traceId: 't1',
      spanId: 's1',
      name: 'turn',
      kind: 'turn',
      startTime: 1,
      endTime: 2,
      attributes: { sessionId: 'demo' },
    } as AgentSpan;
    seen.traceStore!.write(span);

    // `<store>.json` -> `<store>.traces.json`; the `.json` is replaced, not appended.
    const sidecar = path.replace(/\.json$/, '') + '.traces.json';
    expect(existsSync(sidecar)).toBe(true);

    // Durable across processes is the whole point, so read it back through a fresh store.
    const reread = await fileTraceStore(sidecar).listTraces('demo');
    expect(reread).toHaveLength(1);
    expect(reread[0]!.traceId).toBe('t1');
  });

  it('the trace sidecar is JSONL — one span per line, appended', async () => {
    const sidecar = tmpStore('t.traces.json');
    const store = fileTraceStore(sidecar);
    for (const id of ['a', 'b', 'c']) {
      store.write({
        traceId: id, spanId: `s-${id}`, name: 'turn', kind: 'turn',
        startTime: 1, endTime: 2, attributes: { sessionId: 'demo' },
      } as AgentSpan);
    }
    const lines = readFileSync(sidecar, 'utf8').split('\n').filter(Boolean);
    expect(lines).toHaveLength(3);
    // Each line stands alone; the file as a whole is deliberately NOT one JSON document.
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
    expect(() => JSON.parse(readFileSync(sidecar, 'utf8'))).toThrow();
  });

  it('a torn final line does not fail the read', async () => {
    const sidecar = tmpStore('torn.traces.json');
    const store = fileTraceStore(sidecar);
    store.write({
      traceId: 'ok', spanId: 's1', name: 'turn', kind: 'turn',
      startTime: 1, endTime: 2, attributes: { sessionId: 'demo' },
    } as AgentSpan);
    // Simulate a process killed mid-append.
    const { appendFileSync } = await import('node:fs');
    appendFileSync(sidecar, '{"traceId":"partial"');

    const traces = await fileTraceStore(sidecar).listTraces('demo');
    expect(traces).toHaveLength(1);
    expect(traces[0]!.traceId).toBe('ok');
  });
});
