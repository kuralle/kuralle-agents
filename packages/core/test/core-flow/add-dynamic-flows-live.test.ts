import { describe, expect, it } from 'bun:test';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { createRuntime } from '../../src/runtime/Runtime.js';
import { MemoryStore } from '../../src/session/stores/MemoryStore.js';
import { MemoryFlowDefinitionsStore } from '../../src/flows/definition/stores/MemoryFlowDefinitionsStore.js';
import { sampleFlowDefinition } from '../../src/flows/definition/testing.js';
import type { FlowDefinitionsStore } from '../../src/flows/definition/store.js';
import { systemNoteBlocks } from '../../src/runtime/systemNotes.js';
import { stubModel } from '../core-durable/helpers.js';
import { defineTool } from '../../src/tools/effect/defineTool.js';
import type { ChannelDriver } from '../../src/types/channel.js';
import type { StreamPart, TurnHandle } from '../../src/types/stream.js';
import { SessionRunStore } from '../../src/runtime/durable/SessionRunStore.js';

async function collectTurn(handle: TurnHandle): Promise<{ parts: StreamPart[]; text: string }> {
  const parts: StreamPart[] = [];
  for await (const part of handle.events) parts.push(part);
  const result = await handle;
  return { parts, text: result.text };
}

describe('addDynamicFlows mid-session', () => {
  it('a flow added after the first turn is enterable via enter_flow on the next turn', async () => {
    const agent = defineAgent({
      id: 'clerk',
      instructions: 'Help the user.',
      model: stubModel,
    });
    const store = new MemoryFlowDefinitionsStore();
    const runtime = createRuntime({
      agents: [agent],
      defaultAgentId: agent.id,
      defaultModel: stubModel,
      sessionStore: new MemoryStore(),
      flowDefinitionsStore: store,
    });

    let turns = 0;
    let sawEnterFlowTool = false;
    const driver: ChannelDriver = {
      async runAgentTurn(node) {
        turns += 1;
        const toolSet = node.tools ?? {};
        const hasEnter = 'enter_flow' in toolSet;
        if (turns === 1) {
          expect(hasEnter).toBe(false);
          return { text: 'How can I help?', toolResults: [] };
        }
        sawEnterFlowTool = hasEnter;
        return {
          text: '',
          toolResults: [
            {
              name: 'enter_flow',
              args: { flowName: 'refund', reason: 'user asked' },
              result: { __enterFlow: true, flowName: 'refund' },
            },
          ],
          control: { type: 'enterFlow', flowName: 'refund' },
        };
      },
      async awaitUser() {
        return { type: 'message', input: '' };
      },
    };

    const sessionId = 'live-dynamic-flow';
    const first = await collectTurn(runtime.run({ sessionId, input: 'hi', driver }));
    expect(first.text).toBe('How can I help?');
    expect(first.parts.some((part) => part.type === 'flow-enter')).toBe(false);

    await runtime.addDynamicFlows(
      [
        sampleFlowDefinition({
          name: 'refund',
          description: 'Refund a payment',
          start: 'say',
          nodes: [
            {
              kind: 'reply',
              id: 'say',
              response: { template: 'Refund started' },
              next: { end: 'done' },
            },
          ],
        }),
      ],
      { agentId: agent.id },
    );

    const second = await collectTurn(
      runtime.run({ sessionId, input: 'refund please', driver }),
    );

    expect(sawEnterFlowTool).toBe(true);
    expect(second.parts.some((part) => part.type === 'flow-enter' && part.payload.flow === 'refund')).toBe(true);
    expect(
      second.parts.some((part) => part.type === 'text-delta' && part.payload.delta === 'Refund started'),
    ).toBe(true);
    expect(second.parts.some((part) => part.type === 'flow-end' && part.payload.flow === 'refund')).toBe(true);
    expect(turns).toBe(2);

    const runStore = new SessionRunStore(runtime.getSessionStore(), sessionId);
    const runState = await runStore.getRunState(sessionId);
    if (!runState) throw new Error('expected run state after the second turn');
    const notes = systemNoteBlocks(runState);
    expect(notes.some((note) => note.includes('refund') && note.includes('Newly available'))).toBe(true);

    expect(await store.getActive('refund')).not.toBeNull();
  });

  it('validates a harness-level tool and rejects a tool that lives only on another agent', async () => {
    const harnessPing = defineTool({
      name: 'harness_ping',
      description: 'harness ping',
      execute: async () => ({ ok: true }),
    });
    const otherOnly = defineTool({
      name: 'other_only',
      description: 'other agent only',
      execute: async () => ({ ok: true }),
    });
    const clerk = defineAgent({ id: 'clerk', instructions: 'Help.', model: stubModel });
    const other = defineAgent({
      id: 'other',
      instructions: 'Other.',
      model: stubModel,
      tools: { other_only: otherOnly },
    });
    const store = new MemoryFlowDefinitionsStore();
    const harnessTools = { harness_ping: harnessPing };
    const runtime = createRuntime({
      agents: [clerk, other],
      defaultAgentId: clerk.id,
      defaultModel: stubModel,
      sessionStore: new MemoryStore(),
      flowDefinitionsStore: store,
      tools: harnessTools,
    });

    await runtime.addDynamicFlows(
      [
        sampleFlowDefinition({
          name: 'uses_harness',
          start: 'act',
          nodes: [{ kind: 'action', id: 'act', tool: 'harness_ping', next: { end: 'done' } }],
        }),
      ],
      { agentId: clerk.id },
    );

    await expect(
      runtime.addDynamicFlows(
        [
          sampleFlowDefinition({
            name: 'uses_other',
            start: 'act',
            nodes: [{ kind: 'action', id: 'act', tool: 'other_only', next: { end: 'done' } }],
          }),
        ],
        { agentId: clerk.id },
      ),
    ).rejects.toThrow(/not a registered tool/);

    const fresh = createRuntime({
      agents: [clerk, other],
      defaultAgentId: clerk.id,
      defaultModel: stubModel,
      sessionStore: new MemoryStore(),
      flowDefinitionsStore: store,
      tools: harnessTools,
    });
    await fresh.loadDynamicFlows({ agentId: clerk.id });

    let sawEnter = false;
    const driver: ChannelDriver = {
      async runAgentTurn(node) {
        if ('enter_flow' in (node.tools ?? {})) {
          sawEnter = true;
          return {
            text: '',
            toolResults: [
              {
                name: 'enter_flow',
                args: { flowName: 'uses_harness', reason: 'test' },
                result: { __enterFlow: true, flowName: 'uses_harness' },
              },
            ],
            control: { type: 'enterFlow', flowName: 'uses_harness' },
          };
        }
        return { text: 'in flow', toolResults: [] };
      },
      async awaitUser() {
        return { type: 'message', input: '' };
      },
    };
    const result = await collectTurn(
      fresh.run({ sessionId: 'harness-rehydrate', input: 'go', driver }),
    );
    expect(sawEnter).toBe(true);
    expect(
      result.parts.some((part) => part.type === 'flow-end' && part.payload.flow === 'uses_harness'),
    ).toBe(true);
  });

  it('a failed replace-bundle restores refund v1 on a fresh runtime after loadDynamicFlows', async () => {
    const agent = defineAgent({ id: 'clerk', instructions: 'Help.', model: stubModel });
    const inner = new MemoryFlowDefinitionsStore();
    const runtime = createRuntime({
      agents: [agent],
      defaultAgentId: agent.id,
      defaultModel: stubModel,
      sessionStore: new MemoryStore(),
      flowDefinitionsStore: inner,
    });
    await runtime.addDynamicFlows(
      [sampleFlowDefinition({ name: 'refund', description: 'v1' })],
      { agentId: agent.id },
    );
    const v1 = await inner.getActive('refund');
    expect(v1).not.toBeNull();

    let creates = 0;
    const store: FlowDefinitionsStore = {
      async createVersion(def, options) {
        creates += 1;
        if (creates === 2) throw new Error('injected persist failure on createVersion #2');
        return inner.createVersion(def, options);
      },
      setActive: (name, versionId) => inner.setActive(name, versionId),
      getActive: (name) => inner.getActive(name),
      getVersion: (versionId) => inner.getVersion(versionId),
      list: (filter) => inner.list(filter),
      archive: (name) => inner.archive(name),
    };
    await expect(
      runtime.addDynamicFlows(
        [
          sampleFlowDefinition({ name: 'refund', description: 'v2' }),
          sampleFlowDefinition({ name: 'zeta', description: 'new' }),
        ],
        { agentId: agent.id, store, replace: true },
      ),
    ).rejects.toThrow(/injected persist failure/);

    const restored = await store.getActive('refund');
    expect(restored?.versionId).toBe(v1!.versionId);
    expect(restored?.definition.description).toBe('v1');
    expect(await store.getActive('zeta')).toBeNull();

    const fresh = createRuntime({
      agents: [agent],
      defaultAgentId: agent.id,
      defaultModel: stubModel,
      sessionStore: new MemoryStore(),
      flowDefinitionsStore: store,
    });
    await fresh.loadDynamicFlows({ agentId: agent.id });

    const names: string[] = [];
    const driver: ChannelDriver = {
      async runAgentTurn(node) {
        names.push(...Object.keys(node.tools ?? {}).filter((name) => name === 'enter_flow'));
        if ('enter_flow' in (node.tools ?? {})) {
          return {
            text: '',
            toolResults: [
              {
                name: 'enter_flow',
                args: { flowName: 'refund', reason: 'test' },
                result: { __enterFlow: true, flowName: 'refund' },
              },
            ],
            control: { type: 'enterFlow', flowName: 'refund' },
          };
        }
        return { text: 'no enter', toolResults: [] };
      },
      async awaitUser() {
        return { type: 'message', input: '' };
      },
    };
    const result = await collectTurn(
      fresh.run({ sessionId: 'restore-refund-v1', input: 'refund please', driver }),
    );
    expect(names.length).toBeGreaterThan(0);
    expect(
      result.parts.some((part) => part.type === 'flow-enter' && part.payload.flow === 'refund'),
    ).toBe(true);
    expect(result.parts.some((part) => part.type === 'flow-enter' && part.payload.flow === 'zeta')).toBe(
      false,
    );
  });

  it('does not reload a failed bundle on a fresh runtime', async () => {
    const agent = defineAgent({ id: 'clerk', instructions: 'Help.', model: stubModel });
    const inner = new MemoryFlowDefinitionsStore();
    let creates = 0;
    const store: FlowDefinitionsStore = {
      async createVersion(def, options) {
        creates += 1;
        if (creates === 2) throw new Error('injected persist failure on createVersion #2');
        return inner.createVersion(def, options);
      },
      setActive: (name, versionId) => inner.setActive(name, versionId),
      getActive: (name) => inner.getActive(name),
      getVersion: (versionId) => inner.getVersion(versionId),
      list: (filter) => inner.list(filter),
      archive: (name) => inner.archive(name),
    };
    const runtime = createRuntime({
      agents: [agent],
      defaultAgentId: agent.id,
      defaultModel: stubModel,
      sessionStore: new MemoryStore(),
      flowDefinitionsStore: store,
    });
    await expect(
      runtime.addDynamicFlows(
        [sampleFlowDefinition({ name: 'beta' }), sampleFlowDefinition({ name: 'gamma' })],
        { agentId: agent.id },
      ),
    ).rejects.toThrow(/injected persist failure/);

    const fresh = createRuntime({
      agents: [agent],
      defaultAgentId: agent.id,
      defaultModel: stubModel,
      sessionStore: new MemoryStore(),
      flowDefinitionsStore: store,
    });
    await fresh.loadDynamicFlows({ agentId: agent.id });

    const driver: ChannelDriver = {
      async runAgentTurn(node) {
        expect('enter_flow' in (node.tools ?? {})).toBe(false);
        return { text: 'no flows', toolResults: [] };
      },
      async awaitUser() {
        return { type: 'message', input: '' };
      },
    };
    const result = await collectTurn(
      fresh.run({ sessionId: 'no-resurrect', input: 'hi', driver }),
    );
    expect(result.text).toBe('no flows');
  });

  it('serializes same-agent catalog writes and does not block a second agent', async () => {
    const clerk = defineAgent({ id: 'clerk', instructions: 'Help.', model: stubModel });
    const other = defineAgent({ id: 'other', instructions: 'Other.', model: stubModel });
    let releaseClerk!: () => void;
    const clerkGate = new Promise<void>((resolve) => {
      releaseClerk = resolve;
    });
    let clerkEntered!: () => void;
    const clerkStarted = new Promise<void>((resolve) => {
      clerkEntered = resolve;
    });
    const clerkInner = new MemoryFlowDefinitionsStore();
    const otherInner = new MemoryFlowDefinitionsStore();
    const clerkStore: FlowDefinitionsStore = {
      async createVersion(def, options) {
        clerkEntered();
        await clerkGate;
        return clerkInner.createVersion(def, options);
      },
      setActive: (name, versionId) => clerkInner.setActive(name, versionId),
      getActive: (name) => clerkInner.getActive(name),
      getVersion: (versionId) => clerkInner.getVersion(versionId),
      list: (filter) => clerkInner.list(filter),
      archive: (name) => clerkInner.archive(name),
    };
    let otherPersisted = false;
    const otherStore: FlowDefinitionsStore = {
      async createVersion(def, options) {
        otherPersisted = true;
        return otherInner.createVersion(def, options);
      },
      setActive: (name, versionId) => otherInner.setActive(name, versionId),
      getActive: (name) => otherInner.getActive(name),
      getVersion: (versionId) => otherInner.getVersion(versionId),
      list: (filter) => otherInner.list(filter),
      archive: (name) => otherInner.archive(name),
    };
    const runtime = createRuntime({
      agents: [clerk, other],
      defaultAgentId: clerk.id,
      defaultModel: stubModel,
      sessionStore: new MemoryStore(),
    });

    const clerkDone = runtime.addDynamicFlows([sampleFlowDefinition({ name: 'clerk-flow' })], {
      agentId: clerk.id,
      store: clerkStore,
    });
    await clerkStarted;
    await runtime.addDynamicFlows([sampleFlowDefinition({ name: 'other-flow' })], {
      agentId: other.id,
      store: otherStore,
    });
    expect(otherPersisted).toBe(true);
    releaseClerk();
    await clerkDone;

    const sameName = await Promise.allSettled([
      runtime.addDynamicFlows([sampleFlowDefinition({ name: 'dup' })], {
        agentId: clerk.id,
        store: clerkInner,
      }),
      runtime.addDynamicFlows([sampleFlowDefinition({ name: 'dup' })], {
        agentId: clerk.id,
        store: clerkInner,
      }),
    ]);
    expect(sameName.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(sameName.filter((result) => result.status === 'rejected')).toHaveLength(1);
  });
});
