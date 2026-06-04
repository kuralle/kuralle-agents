import { describe, expect, it, mock, afterEach } from 'bun:test';
import type { LanguageModel } from 'ai';
import { z } from 'zod';
import { decide, reply } from '../../src/types/flow.js';
import { defineFlow } from '../../src/types/flow.js';
import { TextDriver } from '../../src/runtime/channels/TextDriver.js';
import { VoiceDriver } from '../../src/runtime/channels/VoiceDriver.js';
import { createRunContext } from '../../src/runtime/ctx.js';
import { CoreToolExecutor } from '../../src/tools/effect/index.js';
import { selectHostTarget } from '../../src/runtime/select.js';
import { hostLoop } from '../../src/runtime/hostLoop.js';
import { resolveReplyNode } from '../../src/flow/nodeBuilders.js';
import { setupDurableHarness } from '../core-durable/helpers.js';
import type { RealtimeAudioClient } from '../../src/realtime/RealtimeAudioClient.js';

afterEach(() => {
  mock.restore();
});

function taggedModel(tag: string): LanguageModel {
  return { provider: tag } as LanguageModel;
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
    const control = taggedModel('control');
    let captured: { model?: LanguageModel; temperature?: number } = {};

    mock.module('ai', () => {
      const actual = require('ai');
      return {
        ...actual,
        generateObject: async (opts: { model?: LanguageModel; temperature?: number }) => {
          captured = opts;
          return { object: { choice: 'a' } };
        },
      };
    });

    const { session, runStore, runState } = await setupDurableHarness('ctrl-decide', 'ctrl-decide-run');
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
      decide: () => 'a',
    });

    await new TextDriver().runStructured(node, ctx);
    expect(captured.model).toBe(control);
    expect(captured.temperature).toBe(0);
  });

  it('VoiceDriver runStructured uses controlModel at temperature 0', async () => {
    const speaker = taggedModel('speaker');
    const control = taggedModel('control');
    let captured: { model?: LanguageModel; temperature?: number } = {};

    mock.module('ai', () => {
      const actual = require('ai');
      return {
        ...actual,
        generateObject: async (opts: { model?: LanguageModel; temperature?: number }) => {
          captured = opts;
          return { object: { choice: 'a' } };
        },
      };
    });

    const { session, runStore, runState } = await setupDurableHarness('ctrl-voice-decide', 'ctrl-voice-decide-run');
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
      decide: () => 'a',
    });

    const client = {
      on: () => {},
      off: () => {},
      updateConfig: async () => {},
    } as unknown as RealtimeAudioClient;

    await new VoiceDriver({ client }).runStructured(node, ctx);
    expect(captured.model).toBe(control);
    expect(captured.temperature).toBe(0);
  });

  it('runSilentExtraction uses controlModel at temperature 0', async () => {
    const speaker = taggedModel('speaker');
    const control = taggedModel('control');
    let captured: { model?: LanguageModel; temperature?: number } = {};

    mock.module('ai', () => {
      const actual = require('ai');
      return {
        ...actual,
        streamText: (opts: { model?: LanguageModel; temperature?: number }) => {
          captured = opts;
          return {
            fullStream: (async function* () {
              /* no text-delta — extraction never speaks */
            })(),
            finishReason: Promise.resolve('stop'),
            response: Promise.resolve({ messages: [] }),
            toolCalls: Promise.resolve([]),
          };
        },
      };
    });

    const { session, runStore, runState } = await setupDurableHarness('ctrl-extract', 'ctrl-extract-run');
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
    expect(captured.model).toBe(control);
    expect(captured.temperature).toBe(0);
  });

  it('selectHostTarget uses the passed model at temperature 0', async () => {
    const control = taggedModel('control');
    let captured: { model?: LanguageModel; temperature?: number } = {};

    mock.module('ai', () => {
      const actual = require('ai');
      return {
        ...actual,
        generateObject: async (opts: { model?: LanguageModel; temperature?: number }) => {
          captured = opts;
          return {
            object: { action: 'keep', flowName: null, agentId: null, reason: null },
          };
        },
      };
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

    expect(captured.model).toBe(control);
    expect(captured.temperature).toBe(0);
  });

  it('hostLoop passes ctx.controlModel to the selector', async () => {
    const speaker = taggedModel('speaker');
    const control = taggedModel('control');
    let selectModel: LanguageModel | undefined;

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
        return { text: 'ok', toolResults: [] };
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
    const speaker = taggedModel('speaker');
    const control = taggedModel('control');
    let captured: { model?: LanguageModel; temperature?: number } = {};

    mock.module('ai', () => {
      const actual = require('ai');
      return {
        ...actual,
        streamText: (opts: { model?: LanguageModel; temperature?: number }) => {
          captured = opts;
          return {
            fullStream: (async function* () {
              yield Object.assign({ type: 'text-delta' }, { text: 'Hi' });
            })(),
            finishReason: Promise.resolve('stop'),
            response: Promise.resolve({ messages: [] }),
            toolCalls: Promise.resolve([]),
          };
        },
      };
    });

    const { session, runStore, runState } = await setupDurableHarness('ctrl-speaker', 'ctrl-speaker-run');
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

    expect(captured.model).toBe(speaker);
    expect(captured.temperature).toBeUndefined();
  });
});
