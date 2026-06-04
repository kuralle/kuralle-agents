import { describe, expect, it, mock, afterEach } from 'bun:test';
import { z } from 'zod';
import type { ValidationCapability, ValidateInput, ValidateDecision } from '../../src/capabilities/ValidationCapability.js';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { reply, action, defineFlow } from '../../src/types/flow.js';
import { TextDriver } from '../../src/runtime/channels/TextDriver.js';
import { createRunContext } from '../../src/runtime/ctx.js';
import { resolveAgentPolicies } from '../../src/runtime/policies/resolvePolicies.js';
import { applyPostTurnPolicies } from '../../src/runtime/policies/agentTurn.js';
import { resolveReplyNode } from '../../src/flow/nodeBuilders.js';
import { runFlow } from '../../src/flow/runFlow.js';
import { CoreToolExecutor } from '../../src/tools/effect/index.js';
import { setupDurableHarness, stubModel } from '../core-durable/helpers.js';
import { SuspendError } from '../../src/runtime/durable/RunStore.js';
import {
  buildAutoRetrieveProvider,
  buildKnowledgeProvider,
  runGatherPhase,
} from '../../src/runtime/grounding/index.js';
import { createInMemoryKnowledgeConfig } from '../../src/runtime/grounding/inMemoryKnowledge.js';
import type { HarnessStreamPart } from '../../src/types/stream.js';
import type { SourceRef } from '../../src/types/voice.js';

afterEach(() => {
  mock.restore();
});

function mockStreamText(text: string) {
  mock.module('ai', () => {
    const actual = require('ai');
    return {
      ...actual,
      streamText: () => ({
        fullStream: (async function* () {
          yield Object.assign({ type: 'text-delta' }, { text });
        })(),
        finishReason: Promise.resolve('stop'),
        response: Promise.resolve({ messages: [] }),
        toolCalls: Promise.resolve([]),
      }),
    };
  });
}

describe('H6 confidence/grounding gate', () => {
  it('reachable: agent validate policies are wired and validate() is called post-turn', async () => {
    const calls: ValidateInput[] = [];
    const policy: ValidationCapability = {
      name: 'spy-validation',
      async validate(input) {
        calls.push(input);
        return { decision: 'continue', confidence: 1 };
      },
    };

    const agent = defineAgent({ id: 'a', validate: [policy], model: stubModel });
    const policies = resolveAgentPolicies(agent);
    expect(policies.validationPolicies).toHaveLength(1);
    expect(policies.validationPolicies[0]?.name).toBe('spy-validation');

    mockStreamText('model claims order placed');

    const { session, runStore, runState } = await setupDurableHarness('h6-reach', 'h6-reach-run');
    runState.messages = [{ role: 'user', content: 'status?' }];
    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: stubModel,
      validationPolicies: policies.validationPolicies,
      emit: () => {},
    });

    const node = reply({ id: 'r', instructions: 'Reply' });
    const driver = new TextDriver();
    await driver.runAgentTurn(resolveReplyNode(node, runState.state), ctx);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.assistantOutput).toBe('model claims order placed');
  });

  it('block → reroute: blocked text is safe, model text is not emitted, recover ends flow', async () => {
    const policy: ValidationCapability = {
      name: 'block-hallucination',
      async validate() {
        return {
          decision: 'block',
          confidence: 0.1,
          rationale: 'ungrounded claim',
          userFacingMessage: 'I cannot confirm that yet.',
        };
      },
    };

    mockStreamText('Your order has been placed!');

    const lowNode = reply({ id: 'low', instructions: 'low', next: () => ({ end: 'low-path' }) });
    const main = reply({
      id: 'main',
      instructions: 'main',
      next: () => lowNode,
    });
    const flow = defineFlow({
      name: 'block-flow',
      description: 'block',
      start: main,
      nodes: [main, lowNode],
    });

    const emitted: string[] = [];
    const driver = new TextDriver();
    const { session, runStore, runState } = await setupDurableHarness('h6-block', 'h6-block-run');
    runState.messages = [{ role: 'user', content: 'place order' }];
    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: stubModel,
      validationPolicies: [policy],
      emit: (part) => {
        if (part.type === 'text-delta') {
          emitted.push((part as { delta: string }).delta);
        }
      },
    });

    const result = await runFlow(flow, runState, driver, ctx);
    expect(result).toEqual({ kind: 'ended', reason: 'ungrounded claim' });
    expect(emitted.join('')).toBe('I cannot confirm that yet.');
    expect(emitted.join('')).not.toContain('order has been placed');
  });

  it('citations threaded: ValidateInput.knowledgeCitations reflect retrieved docs', async () => {
    let received: SourceRef[] = [];
    const policy: ValidationCapability = {
      name: 'citation-check',
      async validate(input) {
        received = [...input.knowledgeCitations];
        return { decision: 'continue', confidence: 1 };
      },
    };

    mockStreamText('Answer from docs');

    const agent = defineAgent({ id: 'support', knowledge: { autoRetrieve: true }, model: stubModel });
    const knowledgeProvider = buildKnowledgeProvider(
      createInMemoryKnowledgeConfig([{ text: 'Return window is 45 days.', id: 'returns-doc' }]),
    );
    const autoRetrieve = buildAutoRetrieveProvider(knowledgeProvider, agent);
    expect(autoRetrieve).toBeDefined();

    const { session, runStore, runState } = await setupDurableHarness('h6-cite', 'h6-cite-run');
    runState.messages = [{ role: 'user', content: 'What is the return window?' }];
    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: stubModel,
      autoRetrieve,
      validationPolicies: [policy],
      emit: () => {},
    });

    const gather = await runGatherPhase(ctx);
    expect(gather.citations?.length).toBeGreaterThan(0);

    const node = reply({ id: 'r', instructions: 'Use knowledge' });
    const driver = new TextDriver();
    await driver.runAgentTurn(resolveReplyNode(node, runState.state), ctx);

    expect(received.length).toBeGreaterThan(0);
    expect(received.some((c) => c.id === 'returns-doc')).toBe(true);
  });

  it('confidenceGate: low confidence routes onLow; high confidence uses node.next', async () => {
    const disambiguate = reply({ id: 'disambiguate', instructions: 'clarify', next: () => ({ end: 'clarified' }) });
    const main = reply({
      id: 'main',
      instructions: 'main',
      confidenceGate: { min: 0.7, onLow: disambiguate },
      next: () => ({ end: 'normal' }),
    });
    const flow = defineFlow({
      name: 'gate-flow',
      description: 'gate',
      start: main,
      nodes: [main, disambiguate],
    });

    const lowPolicy: ValidationCapability = {
      name: 'low-conf',
      async validate() {
        return { decision: 'continue', confidence: 0.3, rationale: 'uncertain' };
      },
    };
    const highPolicy: ValidationCapability = {
      name: 'high-conf',
      async validate() {
        return { decision: 'continue', confidence: 0.9, rationale: 'certain' };
      },
    };

    mockStreamText('maybe answer');

    const driver = new TextDriver();
    const runLow = async () => {
      const { session, runStore, runState } = await setupDurableHarness('h6-low', 'h6-low-run');
      runState.messages = [{ role: 'user', content: 'help' }];
      const ctx = await createRunContext({
        session,
        runState,
        runStore,
        steps: [],
        toolExecutor: new CoreToolExecutor({ tools: {} }),
        model: stubModel,
        validationPolicies: [lowPolicy],
        emit: () => {},
      });
      return runFlow(flow, runState, driver, ctx);
    };

    const runHigh = async () => {
      const { session, runStore, runState } = await setupDurableHarness('h6-high', 'h6-high-run');
      runState.messages = [{ role: 'user', content: 'help' }];
      const ctx = await createRunContext({
        session,
        runState,
        runStore,
        steps: [],
        toolExecutor: new CoreToolExecutor({ tools: {} }),
        model: stubModel,
        validationPolicies: [highPolicy],
        emit: () => {},
      });
      return runFlow(flow, runState, driver, ctx);
    };

    expect(await runLow()).toEqual({ kind: 'ended', reason: 'clarified' });
    expect(await runHigh()).toEqual({ kind: 'ended', reason: 'normal' });
  });

  it('escalate decision → human handoff via __escalate', async () => {
    const policy: ValidationCapability = {
      name: 'escalate-policy',
      async validate() {
        return {
          decision: 'escalate',
          confidence: 0.2,
          rationale: 'needs human review',
          escalationReason: 'low-confidence',
        };
      },
    };

    mockStreamText('I will process a refund now.');

    const main = reply({ id: 'main', instructions: 'main', next: () => ({ end: 'should-not-reach' }) });
    const flow = defineFlow({
      name: 'esc-flow',
      description: 'esc',
      start: main,
      nodes: [main],
    });

    const driver = new TextDriver();
    const { session, runStore, runState } = await setupDurableHarness('h6-esc', 'h6-esc-run');
    runState.messages = [{ role: 'user', content: 'refund' }];
    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: stubModel,
      validationPolicies: [policy],
      emit: () => {},
    });

    await expect(runFlow(flow, runState, driver, ctx)).rejects.toBeInstanceOf(SuspendError);

    const paused = await runStore.getRunState(runState.runId);
    expect(paused?.status).toBe('paused');
    expect(paused?.waitingFor?.signalName).toBe('__escalate');
  });

  it('parity: no validate/confidenceGate behaves like baseline (model text emitted)', async () => {
    const modelText = 'plain answer without gate';
    mockStreamText(modelText);

    const emitted: string[] = [];
    const { session, runStore, runState } = await setupDurableHarness('h6-parity', 'h6-parity-run');
    runState.messages = [{ role: 'user', content: 'hi' }];
    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: stubModel,
      emit: (part) => {
        if (part.type === 'text-delta') {
          emitted.push((part as { delta: string }).delta);
        }
      },
    });

    const node = reply({ id: 'r', instructions: 'Reply', next: () => ({ end: 'done' }) });
    const flow = defineFlow({
      name: 'parity-flow',
      description: 'parity',
      start: node,
      nodes: [node],
    });

    const driver = new TextDriver();
    const result = await runFlow(flow, runState, driver, ctx);

    expect(result).toEqual({ kind: 'ended', reason: 'done' });
    expect(emitted).toEqual([modelText]);

    const post = await applyPostTurnPolicies(ctx, modelText, []);
    expect(post).toEqual({ proceed: true, text: modelText });
  });

  it('audit: block and escalate append validation/safety/escalation entries', async () => {
    const blockPolicy: ValidationCapability = {
      name: 'audit-block',
      async validate() {
        return {
          decision: 'block',
          confidence: 0,
          rationale: 'blocked',
          userFacingMessage: 'blocked safe',
        };
      },
    };

    const { session, runStore, runState } = await setupDurableHarness('h6-audit', 'h6-audit-run');
    runState.messages = [{ role: 'user', content: 'x' }];
    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: stubModel,
      validationPolicies: [blockPolicy],
      emit: () => {},
    });

    await applyPostTurnPolicies(ctx, 'bad output', []);

    const types = session.metadata?.audit?.map((e) => e.type) ?? [];
    expect(types).toContain('safety-block');
    expect(types).toContain('validation');

    session.metadata!.audit = [];
    const escPolicy: ValidationCapability = {
      name: 'audit-esc',
      async validate() {
        return { decision: 'escalate', confidence: 0.1, rationale: 'esc', escalationReason: 'low-confidence' };
      },
    };
    ctx.validationPolicies = [escPolicy];
    await applyPostTurnPolicies(ctx, 'bad', []);
    const types2 = session.metadata?.audit?.map((e) => e.type) ?? [];
    expect(types2).toContain('escalation');
    expect(types2).toContain('validation');
  });
});
