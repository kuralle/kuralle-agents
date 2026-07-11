// H3: pruneStepsBeforeEpoch drops prior-epoch steps so the journal bounds to the current logical run.
import { describe, expect, it } from 'bun:test';
import { buildCtx, reloadRunState, setupDurableHarness } from '../core-durable/helpers.js';

describe('H3: epoch prune keeps only the current logical run steps', () => {
  it('after N fresh epochs, getSteps returns only the current epoch steps', async () => {
    const toolExecutor = {
      execute: async ({ name }: { name: string }) => {
        return { epochMarker: name };
      },
    };

    const { session, runStore, runState } = await setupDurableHarness('sess-prune', 'sess-prune');

    // Epoch 0: record one step.
    const epoch0 = await buildCtx({ session, runStore, runState, toolExecutor });
    await epoch0.tool('mark_epoch_0', {});

    // Simulate N=2 additional fresh logical runs (epochs 1 and 2).
    let current = await reloadRunState(runStore, runState.runId);
    const epoch1 = await buildCtx({ session, runStore, runState: current, toolExecutor });
    await epoch1.tool('mark_epoch_1', {});

    current = await reloadRunState(runStore, runState.runId);
    const epoch2 = await buildCtx({ session, runStore, runState: current, toolExecutor });
    await epoch2.tool('mark_epoch_2', {});

    const steps = await runStore.getSteps(runState.runId);
    expect(steps).toHaveLength(1);
    expect(steps[0]?.epoch).toBe(2);
    expect(steps[0]?.name).toBe('mark_epoch_2');
    expect(steps[0]?.result).toEqual({ epochMarker: 'mark_epoch_2' });
  });
});