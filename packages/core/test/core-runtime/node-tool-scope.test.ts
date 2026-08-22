import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { reply } from '../../src/types/flow.js';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import {
  resolveCollectExtractionNode,
  resolveReplyNode,
} from '../../src/flow/nodeBuilders.js';
import { resolveNodeTools } from '../../src/runtime/channels/resolveNodeTools.js';
import { TextDriver } from '../../src/runtime/channels/TextDriver.js';
import { defineTool, buildToolSet, CoreToolExecutor } from '../../src/tools/effect/index.js';
import { createRunContext } from '../../src/runtime/ctx.js';
import { setupDurableHarness, stubModel } from '../core-durable/helpers.js';
import type { AnyTool } from '../../src/types/effectTool.js';
import type { LanguageModel } from 'ai';
import type { ResolvedNode } from '../../src/types/channel.js';
import type { RunContext } from '../../src/types/run-context.js';
import { mockV3CapturingStreamModel } from '../helpers/mockLanguageModelV3Results.js';

function stubTool(name: string): AnyTool {
  return defineTool({
    name,
    description: `${name} stub`,
    input: z.object({}),
    execute: async () => ({ ok: true, name }),
  });
}

function toolNames(set: ReturnType<typeof resolveNodeTools>): string[] {
  return Object.keys(set ?? {}).sort();
}

function fixtureLayers() {
  const nodeTool = stubTool('node_only');
  const agentTool = stubTool('agent_only');
  const globalTool = stubTool('global_only');
  const memoryTool = stubTool('memory_only');
  const handoff = stubTool('handoff');
  return { nodeTool, agentTool, globalTool, memoryTool, handoff };
}

function resolveFixture(
  scope: 'open' | 'base' | 'closed' | undefined,
  opts: {
    outOfBandControl?: boolean;
    freeConversation?: boolean;
    includeControlOnNode?: boolean;
  } = {},
) {
  const { nodeTool, agentTool, globalTool, memoryTool, handoff } = fixtureLayers();
  const nodeTools: Record<string, AnyTool> = { node_only: nodeTool };
  if (opts.includeControlOnNode) {
    nodeTools.handoff = handoff;
  }
  const node = reply({
    id: 'scope_probe',
    instructions: 'probe',
    tools: buildToolSet(nodeTools),
    ...(scope !== undefined ? { toolScope: scope } : {}),
  });
  const resolved = resolveReplyNode(node, {}, {
    ...(opts.freeConversation ? { freeConversation: true } : {}),
  });
  const ctx = {
    globalTools: { global_only: globalTool },
    workingMemoryTools: { memory_only: memoryTool },
    outOfBandControl: opts.outOfBandControl ?? false,
  };
  // When control is not on the node, put it in agent tools (open-only layer).
  const agentToolDefs: Record<string, AnyTool> = opts.includeControlOnNode
    ? { agent_only: agentTool }
    : { agent_only: agentTool, handoff };
  return {
    names: toolNames(resolveNodeTools(resolved, ctx, agentToolDefs)),
    resolved,
    ctx,
    agentToolDefs,
  };
}

describe('node toolScope (REQ-1..REQ-4)', () => {
  it('REQ-1: open, omitted, and explicit open resolve the same set', () => {
    const omitted = resolveFixture(undefined);
    const explicit = resolveFixture('open');
    expect(omitted.names).toEqual(explicit.names);
    expect(omitted.names).toEqual([
      'agent_only',
      'global_only',
      'handoff',
      'memory_only',
      'node_only',
    ]);
  });

  it('REQ-2: closed equals node tools only; excluded layers absent by name', () => {
    const { names } = resolveFixture('closed');
    expect(names).toEqual(['node_only']);
    expect(names).not.toContain('agent_only');
    expect(names).not.toContain('global_only');
    expect(names).not.toContain('memory_only');
  });

  it('REQ-3: base keeps global + working-memory, drops agent-only', () => {
    const { names } = resolveFixture('base');
    expect(names).toContain('node_only');
    expect(names).toContain('global_only');
    expect(names).toContain('memory_only');
    expect(names).not.toContain('agent_only');
  });

  it('REQ-4: control-tool presence tracks silo alone across all scopes', () => {
    const scopes = ['open', 'base', 'closed'] as const;
    for (const scope of scopes) {
      const siloOff = resolveFixture(scope, {
        outOfBandControl: false,
        includeControlOnNode: true,
      });
      expect(siloOff.names).toContain('handoff');

      const siloOn = resolveFixture(scope, {
        outOfBandControl: true,
        includeControlOnNode: true,
      });
      expect(siloOn.names).not.toContain('handoff');

      const freeConvo = resolveFixture(scope, {
        outOfBandControl: true,
        freeConversation: true,
        includeControlOnNode: true,
      });
      expect(freeConvo.names).toContain('handoff');
    }
  });
});

describe('extraction as closed (REQ-5)', () => {
  async function extractionResolved(model: LanguageModel = stubModel): Promise<{
    resolved: ResolvedNode;
    ctx: RunContext;
    submitName: string;
  }> {
    const submit = defineTool({
      name: 'submit_intake_data',
      description: 'submit',
      input: z.object({ name: z.string() }),
      execute: async (args) => args,
    });
    const resolved = resolveCollectExtractionNode(
      {
        kind: 'collect',
        id: 'intake',
        schema: z.object({ name: z.string() }),
        onComplete: () => ({ end: 'done' }),
      },
      ['name'],
      {},
      submit as AnyTool,
    );
    expect(resolved.toolScope).toBe('closed');

    const { session, runStore, runState } = await setupDurableHarness(
      'extract-scope',
      'extract-scope-run',
    );
    runState.messages = [{ role: 'user', content: 'My name is Riley' }];
    const agentOnly = stubTool('agent_only');
    const globalOnly = stubTool('global_only');
    const ctx = await createRunContext({
      session,
      runStore,
      runState,
      steps: [],
      toolExecutor: new CoreToolExecutor({
        tools: { submit_intake_data: submit, agent_only: agentOnly, global_only: globalOnly },
      }),
      model,
      emit: () => {},
    });
    ctx.globalTools = { global_only: globalOnly };
    return { resolved, ctx, submitName: submit.name };
  }

  it('runExtraction resolves exactly the submit tool', async () => {
    const captured: Array<{ tools?: Record<string, unknown> }> = [];
    const model = mockV3CapturingStreamModel(captured);
    const { resolved, ctx, submitName } = await extractionResolved(model);
    const driver = new TextDriver({
      toolDefs: { agent_only: stubTool('agent_only') },
    });
    await driver.runExtraction(resolved, ctx);
    expect(captured.length).toBeGreaterThan(0);
    const names = Object.keys(captured[0]?.tools ?? {});
    expect(names).toEqual([submitName]);
  });

  it('runAgentTurn fallback resolves the identical closed set', async () => {
    const captured: Array<{ tools?: Record<string, unknown> }> = [];
    const model = mockV3CapturingStreamModel(captured);
    const { resolved, ctx, submitName } = await extractionResolved(model);
    const driver = new TextDriver({
      toolDefs: { agent_only: stubTool('agent_only') },
    });
    await driver.runAgentTurn(resolved, ctx);
    expect(captured.length).toBeGreaterThan(0);
    const names = Object.keys(captured[0]?.tools ?? {});
    expect(names).toEqual([submitName]);
  });
});

describe('digression as base (REQ-6)', () => {
  it('runCollectDigression declares base; agent-only tools absent; control survives freeConversation', async () => {
    const agentOnly = stubTool('agent_only');
    const globalOnly = stubTool('global_only');
    const memoryOnly = stubTool('memory_only');
    const handoff = stubTool('handoff');

    const { session, runStore, runState } = await setupDurableHarness(
      'digression-scope',
      'digression-scope-run',
    );
    runState.messages = [{ role: 'user', content: 'What are your hours?' }];

    const ctx = await createRunContext({
      session,
      runStore,
      runState,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: stubModel,
      emit: () => {},
      outOfBandControl: true,
    });
    ctx.globalTools = { global_only: globalOnly, handoff };
    ctx.workingMemoryTools = { memory_only: memoryOnly };
    ctx.baseInstructions = 'Answer helpfully.';

    let captured: ResolvedNode | undefined;
    const driver = {
      async runAgentTurn(node: ResolvedNode) {
        captured = node;
        return { text: 'We are open 9-5.', toolResults: [] };
      },
      async awaitUser() {
        return { type: 'message' as const, input: '' };
      },
    };

    const agent = defineAgent({
      id: 'digression-probe',
      model: stubModel,
      tools: { agent_only: agentOnly },
      globalTools: { global_only: globalOnly, handoff },
    });

    const { runCollectDigression } = await import('../../src/flow/collectDigression.js');
    const result = await runCollectDigression({
      agent,
      node: { id: 'intake' },
      activeFlowName: 'intake',
      run: runState,
      driver,
      ctx,
      select: async () => ({ kind: 'keep' as const }),
    });

    expect(result).toEqual({ kind: 'answeredThenResume' });
    expect(captured).toBeDefined();
    expect(captured!.toolScope).toBe('base');
    expect(captured!.freeConversation).toBe(true);

    const names = toolNames(
      resolveNodeTools(captured!, ctx, { agent_only: agentOnly }),
    );
    expect(names).toContain('global_only');
    expect(names).toContain('memory_only');
    expect(names).toContain('handoff');
    expect(names).not.toContain('agent_only');
  });
});
