// FINDING 9: a completed flow is excluded from every re-entry surface (guard classifier + enter_flow tool) and __completedFlows is never cleared, so flows are one-shot per session — a user can never run the order flow twice | anchor src/runtime/hostControlTools.ts:14-21, src/runtime/select.ts:56-61, src/runtime/hostLoop.ts:147-151 | proves repeat business is impossible in one session
import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentConfig } from '../../src/types/agentConfig.js';
import { availableHostFlows } from '../../src/runtime/hostControlTools.js';
import { makeRunState } from '../core-durable/helpers.js';

function walkTsFiles(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...walkTsFiles(full));
    } else if (entry.endsWith('.ts')) {
      files.push(full);
    }
  }
  return files;
}

describe('F9: completed flows are permanently unavailable for the session', () => {
  it('availableHostFlows excludes a completed flow forever', () => {
    const orderFlow = { name: 'order', description: 'Place an order', nodes: [], start: 's' };
    const agent = { id: 'a', flows: [orderFlow] } as unknown as AgentConfig;

    const run = makeRunState('sess-1', 'sess-1');
    expect(availableHostFlows(agent, run).map((f) => f.name)).toEqual(['order']);

    // First order completes (hostLoop appends the flow name).
    run.state.__completedFlows = ['order'];

    // "I want to order again" — the flow is gone from both the guard
    // classifier's candidate list and the enter_flow tool surface.
    expect(availableHostFlows(agent, run)).toEqual([]);
  });

  it('no src code ever removes a name from __completedFlows (append is the only write)', () => {
    const srcRoot = join(import.meta.dirname, '../../src');
    const assignments: string[] = [];
    for (const file of walkTsFiles(srcRoot)) {
      const lines = readFileSync(file, 'utf8').split('\n');
      for (const line of lines) {
        if (!line.includes('__completedFlows')) continue;
        if (/__completedFlows\s*=/.test(line) || /delete\b.*__completedFlows/.test(line)) {
          assignments.push(`${file}: ${line.trim()}`);
        }
      }
    }
    // The sole write site is the append in hostLoop; nothing resets or deletes.
    expect(assignments).toHaveLength(1);
    expect(assignments[0]).toContain('hostLoop.ts');
    expect(assignments[0]).toContain('[...completedFlows, flow.name]');
  });
});
