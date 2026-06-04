import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { collect, defineFlow, reply } from '../../src/types/flow.js';
import { runFlow } from '../../src/flow/runFlow.js';
import { TextDriver } from '../../src/runtime/channels/TextDriver.js';
import { createRunContext } from '../../src/runtime/ctx.js';
import { CoreToolExecutor } from '../../src/tools/effect/index.js';
import { setupDurableHarness } from '../core-durable/helpers.js';
import { getCollectData, projectCollectData, schemaSatisfied } from '../../src/flow/extraction.js';
import type { HarnessStreamPart } from '../../src/types/stream.js';

describe('collect extraction regression', () => {
  it('completes collect via submit tool without regression', async () => {
    const replyNode = reply({
      id: 'confirm',
      instructions: 'Confirm the name.',
      next: () => ({ end: 'done' }),
    });
    const collectNode = collect({
      id: 'name',
      schema: z.object({ name: z.string().min(1) }),
      required: ['name'],
      onComplete: () => replyNode,
    });
    const flow = defineFlow({
      name: 'name-flow',
      description: 'collect name',
      start: collectNode,
      nodes: [collectNode, replyNode],
    });

    const driver = new TextDriver();
    const { session, runStore, runState } = await setupDurableHarness('collect-reg-sess', 'collect-reg-run');
    runState.messages = [{ role: 'user', content: 'My name is Riley.' }];
    runState.activeFlow = flow.name;
    runState.activeNode = collectNode.id;

    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: {} as import('ai').LanguageModel,
      emit: () => {},
    });

    const collectingDriver = {
      async runAgentTurn() {
        return {
          text: 'Thanks.',
          toolResults: [
            {
              name: 'submit_name_data',
              args: { name: 'Riley' },
              result: { name: 'Riley' },
            },
          ],
        };
      },
      async awaitUser() {
        return { type: 'message' as const, input: 'next' };
      },
    };

    const result = await runFlow(flow, runState, collectingDriver, ctx);
    expect(result.kind).toBe('ended');
    expect(schemaSatisfied(collectNode, runState.state)).toBe(true);
    expect(getCollectData(runState.state, collectNode.id).name).toBe('Riley');
  });

  it('projects optional collected fields to onComplete, not just required ones', () => {
    // A node may require only `intent` but also collect optional fields (e.g. a
    // welcome step that classifies AND captures occasion/recipient). onComplete
    // must receive those optionals — projecting only `required` silently drops
    // them, breaking any routing that reads them.
    const node = collect({
      id: 'welcome',
      schema: z.object({
        intent: z.enum(['gift', 'browse', 'track']),
        occasion: z.string().optional(),
        recipient: z.string().optional(),
      }),
      required: ['intent'],
      onComplete: () => ({ end: 'done' }),
    });
    const state = {
      __collect_welcome: { intent: 'gift', occasion: 'birthday', recipient: 'amma' },
    } as Record<string, unknown>;

    const projected = projectCollectData(node, state) as Record<string, unknown>;
    expect(projected.intent).toBe('gift');
    expect(projected.occasion).toBe('birthday');
    expect(projected.recipient).toBe('amma');
  });
});

describe('collect extraction is non-speaking (structural backstop)', () => {
  const FORBIDDEN = /processed your order|pay link|order is placed|visit the website|will be delivered/i;

  it('discards model-authored prose from a collect extraction turn — even a malicious one', async () => {
    // A worst-case model that ALWAYS narrates a false downstream outcome while
    // extracting. The framework must never emit or store that text.
    const replyNode = reply({ id: 'done', instructions: 'Thanks.', next: () => ({ end: 'done' }) });
    const collectNode = collect({
      id: 'name',
      schema: z.object({ name: z.string().min(1) }),
      required: ['name'],
      onComplete: () => replyNode,
    });
    const flow = defineFlow({ name: 'name-flow', description: 'x', start: collectNode, nodes: [collectNode, replyNode] });

    const parts: HarnessStreamPart[] = [];
    const maliciousDriver = {
      async runExtraction() {
        return {
          text: "I've processed your order and sent a pay link! Visit the website to finish.",
          toolResults: [{ name: 'submit_name_data', args: { name: 'Riley' }, result: { name: 'Riley' } }],
        };
      },
      async runAgentTurn() {
        return { text: 'Thanks, Riley.', toolResults: [] };
      },
      async awaitUser() {
        return { type: 'message' as const, input: 'My name is Riley' };
      },
    };

    const { session, runStore, runState } = await setupDurableHarness('collect-silent-sess', 'collect-silent-run');
    runState.messages = [{ role: 'user', content: 'My name is Riley' }];
    runState.activeFlow = flow.name;
    runState.activeNode = collectNode.id;
    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: {} as import('ai').LanguageModel,
      emit: (part) => parts.push(part),
    });

    await runFlow(flow, runState, maliciousDriver, ctx);

    // The malicious extraction prose is never emitted as text...
    expect(parts.some((p) => p.type === 'text-delta' && FORBIDDEN.test(String((p as { delta?: string }).delta)))).toBe(false);
    // ...and never appended to conversation history.
    expect(runState.messages.some((m) => m.role === 'assistant' && FORBIDDEN.test(String(m.content)))).toBe(false);
    // Extraction itself still worked (the field was captured).
    expect(getCollectData(runState.state, 'name').name).toBe('Riley');
  });

  it('emits a deterministic ask for missing fields, not model text', async () => {
    const collectNode = collect({
      id: 'contact',
      schema: z.object({ name: z.string().min(1), email: z.string().min(1) }),
      required: ['name', 'email'],
      onComplete: () => ({ end: 'done' }),
    });
    const flow = defineFlow({ name: 'contact-flow', description: 'x', start: collectNode, nodes: [collectNode] });

    const parts: HarnessStreamPart[] = [];
    const partialDriver = {
      async runExtraction() {
        // captures only `name`; emits a lie that must be ignored
        return {
          text: 'Your order is placed!',
          toolResults: [{ name: 'submit_contact_data', args: { name: 'Riley' }, result: { name: 'Riley' } }],
        };
      },
      async runAgentTurn() {
        return { text: 'Your order is placed!', toolResults: [] };
      },
      async awaitUser() {
        return { type: 'message' as const, input: 'I am Riley' };
      },
    };

    const { session, runStore, runState } = await setupDurableHarness('collect-ask-sess', 'collect-ask-run');
    runState.messages = [{ role: 'user', content: 'I am Riley' }];
    runState.activeFlow = flow.name;
    runState.activeNode = collectNode.id;
    const ctx = await createRunContext({
      session,
      runStore,
      runState,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: {} as import('ai').LanguageModel,
      emit: (part) => parts.push(part),
    });

    const result = await runFlow(flow, runState, partialDriver, ctx);

    const texts = parts.filter((p) => p.type === 'text-delta').map((p) => String((p as { delta?: string }).delta));
    expect(result).toEqual({ kind: 'awaitingUser' });
    expect(texts.some((t) => FORBIDDEN.test(t))).toBe(false); // no model lie
    expect(texts.some((t) => /email/i.test(t))).toBe(true); // deterministic ask for the missing field
  });
});
