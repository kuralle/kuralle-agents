import { beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LanguageModel } from 'ai';
import {
  MemoryStore,
  createRuntime,
  type AgentConfig,
  type ChannelDriver,
  type Flow,
  type StreamPart,
  type TurnHandle,
} from '@kuralle-agents/core';
import { consumeAllPendingUserInput } from '../../core/src/runtime/channels/inputBuffer.js';
import { SessionRunStore } from '../../core/src/runtime/durable/SessionRunStore.js';

const backendPath = join(
  mkdtempSync(join(tmpdir(), 'kuralle-property-remediation-')),
  'backend.json',
);
process.env.KURALLE_PM_STATE = backendPath;

let propertyAgent: AgentConfig;
let backend: typeof import('../examples/property-manager/data.js');
const stubModel = {} as LanguageModel;

beforeAll(async () => {
  const [agentModule, dataModule] = await Promise.all([
    import('../examples/property-manager/agent.js'),
    import('../examples/property-manager/data.js'),
  ]);
  propertyAgent = agentModule.default;
  backend = dataModule;
});

async function collectParts(handle: TurnHandle): Promise<{
  parts: StreamPart[];
  result: Awaited<TurnHandle>;
}> {
  const parts: StreamPart[] = [];
  for await (const part of handle.events) parts.push(part);
  return { parts, result: await handle };
}

function withBindingFlow(agent: AgentConfig, flowName: string): {
  agent: AgentConfig;
  flow: Flow;
} {
  const flow = agent.flows?.find((candidate) => candidate.name === flowName);
  if (!flow) throw new Error(`Missing property-manager flow ${flowName}`);
  const bound = { ...flow, binding: true };
  return {
    flow: bound,
    agent: {
      ...agent,
      flows: agent.flows?.map((candidate) =>
        candidate.name === flowName ? bound : candidate,
      ),
    },
  };
}

function driver(options: {
  report?: {
    unitId: string;
    issue: string;
    urgency: 'emergency' | 'urgent' | 'routine';
  };
  fault?: 'same' | 'distinct';
  workOrderId?: string;
}): ChannelDriver {
  return {
    async runExtraction(node) {
      if (node.node.id === 'work_order_intake__extract' && options.report) {
        return {
          text: '',
          toolResults: [
            {
              name: 'submit_work_order_intake_data',
              args: options.report,
              result: options.report,
            },
          ],
        };
      }
      if (node.node.id === 'dispatch_intake__extract' && options.workOrderId) {
        const data = { workOrderId: options.workOrderId };
        return {
          text: '',
          toolResults: [
            {
              name: 'submit_dispatch_intake_data',
              args: data,
              result: data,
            },
          ],
        };
      }
      return { text: '', toolResults: [] };
    },
    async runStructured() {
      return { fault: options.fault ?? 'same' };
    },
    async runAgentTurn(node, ctx) {
      if (node.node.id === 'confirm_dispatch') {
        const match = node.prompt.match(
          /workOrderId (WO-\d+), vendorId ([\w-]+), estimateUsd (\d+(?:\.\d+)?)/,
        );
        if (!match) throw new Error(`Could not resolve frozen dispatch from: ${node.prompt}`);
        const args = {
          workOrderId: match[1]!,
          vendorId: match[2]!,
          estimateUsd: Number(match[3]),
        };
        const def = node.localTools?.dispatch_vendor_with_approval;
        if (!def) throw new Error('Missing node-local approval tool');
        const result = await ctx.tool('dispatch_vendor_with_approval', args, {
          toolCallId: 'property-dispatch-call',
          def,
        });
        return {
          text: 'Owner approval is pending.',
          toolResults: [
            {
              name: 'dispatch_vendor_with_approval',
              args,
              result,
              toolCallId: 'property-dispatch-call',
            },
          ],
        };
      }
      if (node.node.id === 'dispatch_done') {
        throw new Error('dispatch_done must not delegate transactional copy to the model');
      }
      if (node.node.id === 'duplicate_fault_question') {
        return { text: 'Is this a separate fault?', toolResults: [] };
      }
      if (node.node.id === 'intake_done') {
        return {
          text:
            options.fault === 'same'
              ? 'Using existing work order WO-1041; no duplicate was created.'
              : 'Created heating work order WO-1042.',
          toolResults: [],
        };
      }
      return { text: '', toolResults: [] };
    },
    async awaitUser(ctx) {
      return {
        type: 'message',
        input: consumeAllPendingUserInput(ctx.session) ?? '',
      };
    },
  };
}

describe('property-manager R-05/R-09 remediation', () => {
  it('reuses a same fault and creates exactly one explicitly distinct fault', async () => {
    backend.resetBackend();
    const selected = withBindingFlow(propertyAgent, 'raise_work_order');
    const sameStore = new MemoryStore();
    const sameRuntime = createRuntime({
      agents: [selected.agent],
      defaultAgentId: selected.agent.id,
      defaultModel: stubModel,
      sessionStore: sameStore,
      hostSelect: async () => ({ kind: 'enterFlow', flow: selected.flow }),
    });
    const sameDriver = driver({
      report: {
        unitId: 'A-204',
        issue: 'Bedroom window latch broken',
        urgency: 'routine',
      },
      fault: 'same',
    });

    await collectParts(
      sameRuntime.run({
        sessionId: 'same-fault',
        input: 'A-204 window latch, routine',
        driver: sameDriver,
      }),
    );
    const same = await collectParts(
      sameRuntime.run({
        sessionId: 'same-fault',
        input: 'No, this is the same fault.',
        driver: sameDriver,
      }),
    );

    expect(backend.sideEffects.workOrdersCreated).toBe(0);
    expect(backend.WORK_ORDERS.filter((workOrder) => workOrder.id === 'WO-1041')).toHaveLength(1);
    expect(same.result.text).toContain('WO-1041');
    expect(same.result.text).toContain('no duplicate');

    backend.resetBackend();
    const distinctStore = new MemoryStore();
    const distinctRuntime = createRuntime({
      agents: [selected.agent],
      defaultAgentId: selected.agent.id,
      defaultModel: stubModel,
      sessionStore: distinctStore,
      hostSelect: async () => ({ kind: 'enterFlow', flow: selected.flow }),
    });
    const distinctDriver = driver({
      report: {
        unitId: 'A-204',
        issue: 'Radiator cold in bedroom',
        urgency: 'urgent',
      },
      fault: 'distinct',
    });

    await collectParts(
      distinctRuntime.run({
        sessionId: 'distinct-fault',
        input: 'A-204 radiator cold, urgent',
        driver: distinctDriver,
      }),
    );
    const distinct = await collectParts(
      distinctRuntime.run({
        sessionId: 'distinct-fault',
        input: 'Yes, this is a separate fault.',
        driver: distinctDriver,
      }),
    );

    expect(backend.sideEffects.workOrdersCreated).toBe(1);
    expect(backend.WORK_ORDERS.filter((workOrder) => workOrder.id === 'WO-1042')).toEqual([
      {
        id: 'WO-1042',
        unitId: 'A-204',
        issue: 'Radiator cold in bedroom',
        urgency: 'urgent',
        status: 'open',
      },
    ]);
    expect(distinct.result.text).toContain('WO-1042');
  });

  it('derives HVAC from the selected order, executes one frozen approval, and reports dispatched', async () => {
    backend.resetBackend();
    backend.WORK_ORDERS.push({
      id: 'WO-1042',
      unitId: 'A-204',
      issue: 'Radiator cold in bedroom',
      urgency: 'urgent',
      status: 'open',
    });
    backend.persist();

    const selected = withBindingFlow(propertyAgent, 'dispatch_vendor_for_work_order');
    const store = new MemoryStore();
    const runtime = createRuntime({
      agents: [selected.agent],
      defaultAgentId: selected.agent.id,
      defaultModel: stubModel,
      sessionStore: store,
      hostSelect: async () => ({ kind: 'enterFlow', flow: selected.flow }),
    });
    const dispatchDriver = driver({ workOrderId: 'WO-1042' });
    const sessionId = 'dispatch-heating';

    const pending = await collectParts(
      runtime.run({
        sessionId,
        input: 'Dispatch WO-1042',
        driver: dispatchDriver,
      }),
    );
    const paused = pending.parts.find((part) => part.type === 'paused');
    expect(paused?.payload.interrupt.operation).toMatchObject({
      toolName: 'dispatch_vendor_with_approval',
      args: {
        workOrderId: 'WO-1042',
        vendorId: 'v-hvac-1',
        estimateUsd: 320,
      },
    });
    expect(backend.sideEffects.dispatches).toBe(0);

    const resumed = await collectParts(
      runtime.run({
        sessionId,
        signalDelivery: {
          signalId: 'owner-approval-WO-1042',
          requestId: paused!.payload.interrupt.requestId,
          name: '__approval',
          actor: { id: 'owner-kestrel', type: 'user' },
          decision: 'approve',
        },
        driver: dispatchDriver,
      }),
    );

    expect(backend.sideEffects.dispatches).toBe(1);
    expect(backend.WORK_ORDERS.find((workOrder) => workOrder.id === 'WO-1042')).toMatchObject({
      vendorId: 'v-hvac-1',
      estimateUsd: 320,
      status: 'vendor_dispatched',
    });
    expect(resumed.result.text).toBe('Northgate HVAC dispatched, $320.');
    expect(resumed.result.text).not.toContain('pending');
    expect(
      resumed.parts.some(
        (part) => part.type === 'flow-enter' && part.payload.flow === 'raise_work_order',
      ),
    ).toBe(false);

    const runStore = new SessionRunStore(store, sessionId);
    const steps = await runStore.getSteps(sessionId);
    expect(
      steps.filter(
        (step) => step.kind === 'tool' && step.name === 'dispatch_vendor_with_approval',
      ),
    ).toHaveLength(1);
  });
});
