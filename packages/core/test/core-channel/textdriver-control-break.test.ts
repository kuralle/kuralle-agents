import { describe, expect, it } from 'bun:test';
import { reply } from '../../src/types/flow.js';
import { TextDriver } from '../../src/runtime/channels/TextDriver.js';
import { CoreToolExecutor } from '../../src/tools/effect/index.js';
import { createRunContext } from '../../src/runtime/ctx.js';
import { resolveReplyNode } from '../../src/flow/nodeBuilders.js';
import { createEnterFlowTool } from '../../src/tools/enterFlow.js';
import { defineFlow } from '../../src/types/flow.js';
import { setupDurableHarness } from '../core-durable/helpers.js';
import {
  mockV3MultiStepStreamModel,
  mockV3ToolCallStreamResult,
} from '../helpers/mockLanguageModelV3Results.js';

describe('TextDriver control break', () => {
  it('stops the speaking loop after a control tool sets out.control (exactly one streamText)', async () => {
    let streamCalls = 0;
    const end = reply({ id: 'end', instructions: 'done', next: () => ({ end: 'ok' }) });
    const flow = defineFlow({
      name: 'target-flow',
      description: 'Target',
      start: end,
      nodes: [end],
    });
    const enterFlow = createEnterFlowTool([flow]);

    const model = mockV3MultiStepStreamModel([
      () => {
        streamCalls += 1;
        return mockV3ToolCallStreamResult(
          'enter_flow',
          'call-enter',
          JSON.stringify({ flowName: 'target-flow', reason: 'user asked' }),
          10,
        );
      },
      () => {
        streamCalls += 1;
        return mockV3ToolCallStreamResult(
          'enter_flow',
          'call-should-not-run',
          JSON.stringify({ flowName: 'target-flow', reason: 'never' }),
          100,
        );
      },
    ]);

    const { session, runStore, runState } = await setupDurableHarness('ctrl-break', 'ctrl-break');
    runState.messages = [{ role: 'user', content: 'Route me' }];
    const toolExecutor = new CoreToolExecutor({ tools: { enter_flow: enterFlow } });
    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor,
      model,
      emit: () => {},
    });

    const node = reply({ id: 'host', instructions: 'Route the user' });
    const resolved = resolveReplyNode(node, {}, { freeConversation: true });
    resolved.hostControl = { dispatchMode: 'strict', advisoryDispatch: false };
    resolved.localTools = { enter_flow: enterFlow };
    Object.assign(resolved.tools ?? {}, { enter_flow: enterFlow });

    const driver = new TextDriver({ toolDefs: { enter_flow: enterFlow } });
    const result = await driver.runAgentTurn(resolved, ctx);

    expect(result.control?.type).toBe('enterFlow');
    expect(streamCalls).toBe(1);
  });
});
