import { describe, expect, it } from 'bun:test';
import { MockLanguageModelV3 } from 'ai/test';
import { z } from 'zod';
import { decide, reply } from '../../src/types/flow.js';
import { defineFlow } from '../../src/types/flow.js';
import { TextDriver } from '../../src/runtime/channels/TextDriver.js';
import { createRunContext } from '../../src/runtime/ctx.js';
import { CoreToolExecutor } from '../../src/tools/effect/index.js';
import { selectHostTarget } from '../../src/runtime/select.js';
import { hostLoop } from '../../src/runtime/hostLoop.js';
import { resolveReplyNode } from '../../src/flow/nodeBuilders.js';
import { setupDurableHarness } from '../core-durable/helpers.js';
import {
  mockV3GenerateResult,
  mockV3StreamResult,
} from '../helpers/mockLanguageModelV3Results.js';

function taggedModel(tag: string): MockLanguageModelV3 {
  return new MockLanguageModelV3({ provider: tag, modelId: tag });
}

describe('control model channel (H2)', () => {
  it('defaults controlModel to the speaker model when unset', async () => {
    const speaker = taggedModel('speaker');
    const { session, runStore, runState } = await setupDurableHarness('ctrl-default', 'ctrl-default-run');
    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: speaker,
      emit: () => {},
    });
    expect(ctx.controlModel).toBe(speaker);
    expect(ctx.model).toBe(speaker);
  });

  it('uses agent.controlModel override when set', async () => {
    const speaker = taggedModel('speaker');
    const control = taggedModel('control');
    const { session, runStore, runState } = await setupDurableHarness('ctrl-override', 'ctrl-override-run');
    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: speaker,
      controlModel: control,
      emit: () => {},
    });
    expect(ctx.model).toBe(speaker);
    expect(ctx.controlModel).toBe(control);
  });

  it('runStructured (decide) uses controlModel at temperature 0', async () => {
    const speaker = taggedModel('speaker');
    const control = new MockLanguageModelV3({
      doGenerate: async () => mockV3GenerateResult(JSON.stringify({ choice: 'a' })),
    });

    const { session, runStore, runState } = await setupDurableHarness('ctrl-decide', 'ctrl-decide-run');
    runState.messages = [{ role: 'user', content: 'pick one' }];
    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: speaker,
      controlModel: control,
      emit: () => {},
    });

    const node = decide({
      id: 'pick',
      instructions: 'Choose',
      schema: z.object({ choice: z.string() }),
      decide: () => 'stay',
    });

    await new TextDriver().runStructured(node, ctx);
    expect(control.doGenerateCalls).toHaveLength(1);
    expect(speaker.doGenerateCalls).toHaveLength(0);
    expect(control.doGenerateCalls[0]?.temperature).toBe(0);
  });

  it('runSilentExtraction uses controlModel at temperature 0', async () => {
    const speaker = taggedModel('speaker');
    const control = new MockLanguageModelV3({
      doStream: async () => mockV3StreamResult(''),
    });

    const { session, runStore, runState } = await setupDurableHarness('ctrl-extract', 'ctrl-extract-run');
    runState.messages = [{ role: 'user', content: 'extract fields' }];
    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: speaker,
      controlModel: control,
      emit: () => {},
    });

    const node = reply({ id: 'collect-step', instructions: 'Extract fields' });
    await new TextDriver().runExtraction(resolveReplyNode(node, {}), ctx);
    expect(control.doStreamCalls).toHaveLength(1);
    expect(speaker.doStreamCalls).toHaveLength(0);
    expect(control.doStreamCalls[0]?.temperature).toBe(0);
  });

  it('selectHostTarget uses the passed model at temperature 0', async () => {
    const control = new MockLanguageModelV3({
      doGenerate: async () =>
        mockV3GenerateResult(
          JSON.stringify({
            action: 'keep',
            flowName: null,
            agentId: null,
            reason: null,
            confidence: null,
          }),
        ),
    });

    const end = reply({ id: 'end', instructions: 'done', next: () => ({ end: 'ok' }) });
    const faq = defineFlow({
      name: 'faq',
      description: 'Answer FAQs',
      start: end,
      nodes: [end],
    });
    const billing = defineFlow({
      name: 'billing',
      description: 'Billing questions',
      start: end,
      nodes: [end],
    });

    const { session, runStore, runState } = await setupDurableHarness('ctrl-route', 'ctrl-route-run');
    runState.messages = [{ role: 'user', content: 'help me' }];

    await selectHostTarget({
      agent: { id: 'router', flows: [faq, billing] },
      run: runState,
      model: control,
    });

    expect(control.doGenerateCalls).toHaveLength(1);
    expect(control.doGenerateCalls[0]?.temperature).toBe(0);
  });

  it('hostLoop passes ctx.controlModel to the selector', async () => {
    const speaker = taggedModel('speaker');
    const control = taggedModel('control');
    let selectModel: import('ai').LanguageModel | undefined;

    const end = reply({ id: 'end', instructions: 'done', next: () => ({ end: 'ok' }) });
    const flow = defineFlow({
      name: 'faq',
      description: 'Answer FAQs',
      start: end,
      nodes: [end],
    });

    const agent = { id: 'flowy', flows: [flow], model: speaker };
    const { session, runStore, runState } = await setupDurableHarness('ctrl-host', 'ctrl-host-run');
    runState.messages = [{ role: 'user', content: 'faq please' }];

    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: speaker,
      controlModel: control,
      emit: () => {},
    });

    const driver = {
      async runAgentTurn() {
        return { text: '', toolResults: [] };
      },
      async awaitUser() {
        return { type: 'message' as const, input: 'more' };
      },
    };

    await hostLoop({
      agent,
      run: runState,
      driver,
      ctx,
      select: async (opts) => {
        selectModel = opts.model;
        return { kind: 'keep' as const };
      },
    });

    expect(selectModel).toBe(control);
  });

  it('runAgentTurn (speaker) uses ctx.model without forcing temperature 0', async () => {
    const speaker = new MockLanguageModelV3({
      doStream: async () => mockV3StreamResult('Hi'),
    });
    const control = taggedModel('control');

    const { session, runStore, runState } = await setupDurableHarness('ctrl-speaker', 'ctrl-speaker-run');
    runState.messages = [{ role: 'user', content: 'hello' }];
    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: speaker,
      controlModel: control,
      emit: () => {},
    });

    const node = reply({ id: 'greet', instructions: 'Say hello' });
    await new TextDriver().runAgentTurn(resolveReplyNode(node, {}), ctx);

    expect(speaker.doStreamCalls).toHaveLength(1);
    expect(control.doStreamCalls).toHaveLength(0);
    expect(speaker.doStreamCalls[0]?.temperature).toBeUndefined();
  });
});
