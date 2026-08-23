import { join } from 'node:path';
import type { SessionEventLog, SessionStore, TraceStore } from '@kuralle-agents/core';
import { fileSessionEventLog } from './fileEventLog.js';
import { fileSessionStore } from './fileStore.js';
import { fileTraceStore } from './fileTraceStore.js';

export interface SessionStores {
  store: SessionStore;
  traces: TraceStore;
  eventLog: SessionEventLog;
  storePath: string;
}

export function sessionStores(storePath: string): SessionStores {
  const store = fileSessionStore(storePath);
  const base = storePath.replace(/\.json$/, '');
  return {
    store,
    traces: fileTraceStore(`${base}.traces.jsonl`),
    eventLog: fileSessionEventLog(`${base}.events.jsonl`),
    storePath,
  };
}

export function defaultStorePath(): string {
  return join(process.cwd(), 'runs/tui-sessions.json');
}
