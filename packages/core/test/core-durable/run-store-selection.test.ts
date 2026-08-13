import { describe, expect, it } from 'bun:test';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { MemoryStore } from '../../src/session/stores/MemoryStore.js';
import type { RunState, StepRecord } from '../../src/runtime/durable/types.js';
import type { RunStore } from '../../src/runtime/durable/RunStore.js';
import { openRun } from '../../src/runtime/openRun.js';
import { stubModel } from './helpers.js';

class RecordingRunStore implements RunStore {
  readonly inits: string[] = [];
  readonly puts: string[] = [];

  async appendStep(_runId: string, _record: StepRecord): Promise<void> {}
  async finalizeStep(): Promise<void> {}
  async getSteps(): Promise<StepRecord[]> {
    return [];
  }
  async getRunState(): Promise<RunState | null> {
    return null;
  }
  async putRunState(state: RunState): Promise<void> {
    this.puts.push(state.runId);
  }
  async initRun(state: RunState): Promise<void> {
    this.inits.push(state.runId);
  }
  async *listRuns() {}
  async deleteRun(): Promise<void> {}
}

describe('HarnessConfig.runStore construction seam', () => {
  it('openRun uses the injected RunStore instead of SessionRunStore', async () => {
    const agent = defineAgent({ id: 'agent-1', model: stubModel });
    const sessionStore = new MemoryStore();
    const runStore = new RecordingRunStore();

    const opened = await openRun(new Map([[agent.id, agent]]), {
      sessionId: 'sel-runstore',
      defaultAgentId: agent.id,
      sessionStore,
      runStore,
    });

    expect(opened.runStore).toBe(runStore);
    expect(runStore.inits).toEqual([opened.runState.runId]);
    expect(opened.runState.sessionId).toBe('sel-runstore');
  });
});
