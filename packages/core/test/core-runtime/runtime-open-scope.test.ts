import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { defineFlow, reply } from '../../src/types/flow.js';
import { createRuntime } from '../../src/runtime/Runtime.js';
import { MemoryStore } from '../../src/session/stores/MemoryStore.js';
import { SessionRunStore } from '../../src/runtime/durable/SessionRunStore.js';
import { defineTool } from '../../src/tools/effect/index.js';
import { makeRunState, makeTestSession } from '../core-durable/helpers.js';
import { mockV3CapturingStreamModel } from '../helpers/mockLanguageModelV3Results.js';

describe('runtime open toolScope', () => {
  it('includes agent.tools on open flow replies via createRuntime', async () => {
    const seenToolSets: Array<{ tools?: Record<string, unknown> }> = [];
    const model = mockV3CapturingStreamModel(seenToolSets);

    const agentOnly = defineTool({
      name: 'agent_only',
      description: 'Agent-only tool',
      input: z.object({}),
      execute: async () => ({ source: 'agent' }),
    });
    const globalOnly = defineTool({
      name: 'global_only',
      description: 'Global tool',
      input: z.object({}),
      execute: async () => ({ source: 'global' }),
    });
    const flowReply = reply({
      id: 'flow_reply',
      instructions: 'Reply.',
      next: () => ({ end: 'done' }),
    });
    const flow = defineFlow({
      name: 'open-scope-flow',
      description: 'Open-scope probe',
      start: flowReply,
      nodes: [flowReply],
    });
    const agent = defineAgent({
      id: 'scope-agent',
      instructions: 'Help.',
      model,
      tools: { agent_only: agentOnly },
      globalTools: { global_only: globalOnly },
      flows: [flow],
    });

    const sessionId = 'runtime-open-scope';
    const sessionStore = new MemoryStore();
    await sessionStore.save(makeTestSession(sessionId));
    const runStore = new SessionRunStore(sessionStore, sessionId);
    const runState = makeRunState(sessionId, sessionId);
    runState.activeAgentId = agent.id;
    runState.activeFlow = flow.name;
    await runStore.initRun(runState);

    const runtime = createRuntime({
      agents: [agent],
      defaultAgentId: agent.id,
      sessionStore,
    });
    await runtime.runOnce({ sessionId, input: 'go' });

    expect(seenToolSets).toHaveLength(1);
    const toolNames = Object.keys(seenToolSets[0]?.tools ?? {}).sort();
    expect(toolNames).toContain('global_only');
    expect(toolNames).toContain('agent_only');
  });

  it('excludes agent.tools on base and closed scopes via createRuntime', async () => {
    const seenToolSets: Array<{ tools?: Record<string, unknown> }> = [];
    const model = mockV3CapturingStreamModel(seenToolSets);

    const agentOnly = defineTool({
      name: 'agent_only',
      description: 'Agent-only tool',
      input: z.object({}),
      execute: async () => ({ source: 'agent' }),
    });
    const globalOnly = defineTool({
      name: 'global_only',
      description: 'Global tool',
      input: z.object({}),
      execute: async () => ({ source: 'global' }),
    });

    for (const scope of ['base', 'closed'] as const) {
      seenToolSets.length = 0;
      const flowReply = reply({
        id: `flow_reply_${scope}`,
        instructions: 'Reply.',
        toolScope: scope,
        next: () => ({ end: 'done' }),
      });
      const flow = defineFlow({
        name: `scope-flow-${scope}`,
        description: `${scope} scope probe`,
        start: flowReply,
        nodes: [flowReply],
      });
      const agent = defineAgent({
        id: `scope-agent-${scope}`,
        instructions: 'Help.',
        model,
        tools: { agent_only: agentOnly },
        globalTools: { global_only: globalOnly },
        flows: [flow],
      });

      const sessionId = `runtime-${scope}-scope`;
      const sessionStore = new MemoryStore();
      await sessionStore.save(makeTestSession(sessionId));
      const runStore = new SessionRunStore(sessionStore, sessionId);
      const runState = makeRunState(sessionId, sessionId);
      runState.activeAgentId = agent.id;
      runState.activeFlow = flow.name;
      await runStore.initRun(runState);

      const runtime = createRuntime({
        agents: [agent],
        defaultAgentId: agent.id,
        sessionStore,
      });
      await runtime.runOnce({ sessionId, input: 'go' });

      expect(seenToolSets).toHaveLength(1);
      expect(Object.keys(seenToolSets[0]?.tools ?? {})).not.toContain('agent_only');
    }
  });
});
