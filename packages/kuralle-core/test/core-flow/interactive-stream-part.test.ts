import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { collect, decide, defineFlow, reply } from '../../src/types/flow.js';
import { createRuntime } from '../../src/runtime/Runtime.js';
import { MemoryStore } from '../../src/session/stores/MemoryStore.js';
import { sessionDerivedRunId } from '../../src/runtime/openRun.js';
import { stubModel } from '../core-durable/helpers.js';
import type { HostSelection } from '../../src/runtime/select.js';
import type { ChannelDriver } from '../../src/types/channel.js';
import type { HarnessStreamPart } from '../../src/types/stream.js';

function classifyStreamPart(part: HarnessStreamPart): 'text' | 'flow' | 'other' {
  switch (part.type) {
    case 'text-start':
    case 'text-delta':
    case 'text-end':
    case 'text-cancel':
      return 'text';
    case 'flow-enter':
    case 'node-enter':
    case 'node-exit':
    case 'flow-transition':
    case 'flow-end':
      return 'flow';
    default:
      return 'other';
  }
}

const driverWithStructured: ChannelDriver = {
  async runAgentTurn() {
    return { text: '', toolResults: [] };
  },
  async awaitUser() {
    return { type: 'message', input: 'x' };
  },
  async runStructured() {
    return { choice: 'a' };
  },
};

describe('interactive stream part', () => {
  it('interactive_part_is_additive', () => {
    const existing: HarnessStreamPart[] = [
      { type: 'text-delta', id: 't0', delta: 'hi' },
      { type: 'node-enter', nodeName: 'n' },
      { type: 'done', sessionId: 's' },
    ];
    const interactive: HarnessStreamPart = {
      type: 'interactive',
      nodeId: 'pick',
      options: [{ id: 'a', label: 'A' }],
      prompt: 'Choose',
    };
    for (const part of [...existing, interactive]) {
      expect(['text', 'flow', 'other']).toContain(classifyStreamPart(part));
    }
    expect(classifyStreamPart(interactive)).toBe('other');
  });

  it('interactive_emitted_on_node_entry', async () => {
    const endNode = reply({ id: 'end', instructions: 'Done', next: () => ({ end: 'done' }) });
    const decideNode = decide({
      id: 'pick',
      instructions: 'Choose one',
      schema: z.object({ choice: z.string() }),
      choices: [
        { id: 'a', label: 'Option A' },
        { id: 'b', label: 'Option B' },
      ],
      decide: () => endNode,
    });
    const plainReply = reply({ id: 'plain', instructions: 'Hello', next: () => ({ end: 'done' }) });

    const flowWithChoices = defineFlow({
      name: 'choices-flow',
      description: 'Interactive choices',
      start: decideNode,
      nodes: [decideNode, endNode],
    });

    const flowWithoutChoices = defineFlow({
      name: 'plain-flow',
      description: 'No choices',
      start: plainReply,
      nodes: [plainReply],
    });

    const agentWithChoices = defineAgent({
      id: 'with-choices',
      flows: [flowWithChoices],
      model: stubModel,
    });
    const agentPlain = defineAgent({
      id: 'plain',
      flows: [flowWithoutChoices],
      model: stubModel,
    });

    const sessionStoreChoices = new MemoryStore();
    const hostSelectChoices = async (): Promise<HostSelection> => ({
      kind: 'enterFlow',
      flow: flowWithChoices,
    });
    const runtime = createRuntime({
      agents: [agentWithChoices],
      defaultAgentId: 'with-choices',
      sessionStore: sessionStoreChoices,
      defaultModel: stubModel,
      hostSelect: hostSelectChoices,
    });

    const sessionStorePlain = new MemoryStore();
    const hostSelectPlain = async (): Promise<HostSelection> => ({
      kind: 'enterFlow',
      flow: flowWithoutChoices,
    });
    const runtimePlain = createRuntime({
      agents: [agentPlain],
      defaultAgentId: 'plain',
      sessionStore: sessionStorePlain,
      defaultModel: stubModel,
      hostSelect: hostSelectPlain,
    });

    const withChoicesId = 'interactive-with-choices';
    const partsWithChoices: HarnessStreamPart[] = [];
    const handle1 = runtime.run({
      sessionId: withChoicesId,
      input: 'start',
      driver: driverWithStructured,
    });
    for await (const part of handle1.events) {
      partsWithChoices.push(part);
    }
    await handle1;

    const interactiveParts = partsWithChoices.filter((p) => p.type === 'interactive');
    expect(interactiveParts.length).toBeGreaterThanOrEqual(1);
    expect(interactiveParts[0]).toMatchObject({
      type: 'interactive',
      nodeId: 'pick',
      prompt: 'Choose one',
      options: [
        { id: 'a', label: 'Option A' },
        { id: 'b', label: 'Option B' },
      ],
    });

    const withoutChoicesId = 'interactive-without-choices';
    const partsWithout: HarnessStreamPart[] = [];
    const handle2 = runtimePlain.run({
      sessionId: withoutChoicesId,
      input: 'start',
      driver: driverWithStructured,
    });
    for await (const part of handle2.events) {
      partsWithout.push(part);
    }
    await handle2;

    expect(partsWithout.some((p) => p.type === 'interactive')).toBe(false);
    expect(sessionDerivedRunId(withoutChoicesId)).toBeTruthy();
  });
});
