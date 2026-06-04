import { describe, expect, it, mock, afterEach } from 'bun:test';
import type { LanguageModel } from 'ai';
import { z } from 'zod';
import { decide } from '../../src/types/flow.js';
import {
  CHOICE_NONE,
  buildChoiceEnumSchema,
  isChoiceFieldSchema,
  isConstrainedChoiceEnumSchema,
  matchChoiceFromInput,
} from '../../src/flow/choiceMatch.js';
import { TextDriver } from '../../src/runtime/channels/TextDriver.js';
import { VoiceDriver } from '../../src/runtime/channels/VoiceDriver.js';
import { createRunContext } from '../../src/runtime/ctx.js';
import { CoreToolExecutor } from '../../src/tools/effect/index.js';
import { selectHostTarget } from '../../src/runtime/select.js';
import { defineFlow, reply } from '../../src/types/flow.js';
import { setupDurableHarness } from '../core-durable/helpers.js';
import type { RealtimeAudioClient } from '../../src/realtime/RealtimeAudioClient.js';

afterEach(() => {
  mock.restore();
});

function choiceDecideNode() {
  const node = decide({
    id: 'cart',
    instructions: 'Review the cart',
    schema: z.object({ choice: z.string() }),
    decide: (data) => {
      const choice = (data as { choice: string }).choice;
      if (choice === 'checkout') return { end: 'checkout' };
      if (choice === 'more') return { end: 'more' };
      return 'stay';
    },
  });
  node.choices = [
    { id: 'checkout', label: 'Checkout' },
    { id: 'more', label: 'Add another gift' },
  ];
  return node;
}

describe('H4 choice-decide constrained enum + code-first', () => {
  it('buildChoiceEnumSchema rejects ids outside the closed enum', () => {
    const schema = buildChoiceEnumSchema([
      { id: 'checkout', label: 'Checkout' },
      { id: 'more', label: 'Add another gift' },
    ]);
    expect(schema.safeParse({ choice: 'checkout' }).success).toBe(true);
    expect(schema.safeParse({ choice: CHOICE_NONE }).success).toBe(true);
    expect(schema.safeParse({ choice: 'bogus-id' }).success).toBe(false);
  });

  it('generateObject receives the closed enum schema for choice-decides', async () => {
    let capturedSchema: unknown;
    mock.module('ai', () => {
      const actual = require('ai');
      return {
        ...actual,
        generateObject: async ({ schema }: { schema: unknown }) => {
          capturedSchema = schema;
          return { object: { choice: CHOICE_NONE } };
        },
      };
    });

    const { session, runStore, runState } = await setupDurableHarness('enum-schema', 'enum-schema-run');
    runState.messages = [{ role: 'user', content: 'something unrelated entirely' }];
    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: {} as LanguageModel,
      emit: () => {},
    });

    await new TextDriver().runStructured(choiceDecideNode(), ctx);

    expect(isConstrainedChoiceEnumSchema(capturedSchema)).toBe(true);
    const parsed = (capturedSchema as ReturnType<typeof buildChoiceEnumSchema>).safeParse({
      choice: 'not-a-real-id',
    });
    expect(parsed.success).toBe(false);
  });

  it('exact id match skips generateObject', async () => {
    let llmCalled = false;
    mock.module('ai', () => {
      const actual = require('ai');
      return {
        ...actual,
        generateObject: async () => {
          llmCalled = true;
          throw new Error('LLM should not run on exact match');
        },
      };
    });

    const { session, runStore, runState } = await setupDurableHarness('code-first-id', 'code-first-id-run');
    runState.messages = [{ role: 'user', content: 'checkout' }];
    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: {} as LanguageModel,
      emit: () => {},
    });

    const result = await new TextDriver().runStructured(choiceDecideNode(), ctx);
    expect(result).toEqual({ choice: 'checkout' });
    expect(llmCalled).toBe(false);
  });

  it('exact label match skips generateObject', async () => {
    let llmCalled = false;
    mock.module('ai', () => {
      const actual = require('ai');
      return {
        ...actual,
        generateObject: async () => {
          llmCalled = true;
          throw new Error('LLM should not run on label match');
        },
      };
    });

    const { session, runStore, runState } = await setupDurableHarness('code-first-label', 'code-first-label-run');
    runState.messages = [{ role: 'user', content: 'Add another gift' }];
    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: {} as LanguageModel,
      emit: () => {},
    });

    const result = await new TextDriver().runStructured(choiceDecideNode(), ctx);
    expect(result).toEqual({ choice: 'more' });
    expect(llmCalled).toBe(false);
  });

  it('ambiguous input falls through to constrained generateObject', async () => {
    let llmCalled = false;
    mock.module('ai', () => {
      const actual = require('ai');
      return {
        ...actual,
        generateObject: async () => {
          llmCalled = true;
          return { object: { choice: 'checkout' } };
        },
      };
    });

    const { session, runStore, runState } = await setupDurableHarness('ambig', 'ambig-run');
    runState.messages = [{ role: 'user', content: 'something unrelated entirely' }];
    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: {} as LanguageModel,
      emit: () => {},
    });

    const result = await new TextDriver().runStructured(choiceDecideNode(), ctx);
    expect(llmCalled).toBe(true);
    expect(result).toEqual({ choice: 'checkout' });
  });

  it('__none from the model maps to stay via decide', async () => {
    mock.module('ai', () => {
      const actual = require('ai');
      return {
        ...actual,
        generateObject: async () => ({ object: { choice: CHOICE_NONE } }),
      };
    });

    const node = choiceDecideNode();
    const { session, runStore, runState } = await setupDurableHarness('none-stay', 'none-stay-run');
    runState.messages = [{ role: 'user', content: 'something unrelated entirely' }];
    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: {} as LanguageModel,
      emit: () => {},
    });

    const structured = await new TextDriver().runStructured(node, ctx);
    const branch = await node.decide!(structured, runState.state);
    expect(branch).toBe('stay');
  });

  it('VoiceDriver runStructured matches TextDriver code-first + enum', async () => {
    let llmCalled = false;
    mock.module('ai', () => {
      const actual = require('ai');
      return {
        ...actual,
        generateObject: async () => {
          llmCalled = true;
          throw new Error('LLM should not run');
        },
      };
    });

    const { session, runStore, runState } = await setupDurableHarness('voice-code', 'voice-code-run');
    runState.messages = [{ role: 'user', content: 'checkout' }];
    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: {} as LanguageModel,
      emit: () => {},
    });

    const client = {
      on: () => {},
      off: () => {},
      updateConfig: async () => {},
    } as unknown as RealtimeAudioClient;

    const result = await new VoiceDriver({ client }).runStructured(choiceDecideNode(), ctx);
    expect(result).toEqual({ choice: 'checkout' });
    expect(llmCalled).toBe(false);
  });

  it('custom non-choice schema keeps legacy unconstrained generateObject', async () => {
    let capturedSchema: unknown;
    mock.module('ai', () => {
      const actual = require('ai');
      return {
        ...actual,
        generateObject: async ({ schema }: { schema: unknown }) => {
          capturedSchema = schema;
          return { object: { action: 'hold' } };
        },
      };
    });

    const node = decide({
      id: 'custom',
      instructions: 'Classify',
      schema: z.object({ action: z.enum(['hold', 'cancel']) }),
      decide: () => 'stay',
    });
    node.choices = [{ id: 'hold', label: 'Hold' }];

    const { session, runStore, runState } = await setupDurableHarness('custom-schema', 'custom-schema-run');
    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: {} as LanguageModel,
      emit: () => {},
    });

    await new TextDriver().runStructured(node, ctx);
    expect(isChoiceFieldSchema(capturedSchema)).toBe(false);
  });

  it('selectHostTarget resolves a clear keyword route without generateObject', async () => {
    let llmCalled = false;
    mock.module('ai', () => {
      const actual = require('ai');
      return {
        ...actual,
        generateObject: async () => {
          llmCalled = true;
          throw new Error('LLM should not run on deterministic route');
        },
      };
    });

    const end = reply({ id: 'end', instructions: 'done', next: () => ({ end: 'ok' }) });
    const billing = defineFlow({
      name: 'billing',
      description: 'Billing questions',
      start: end,
      nodes: [end],
    });
    const faq = defineFlow({
      name: 'faq',
      description: 'Answer FAQs',
      start: end,
      nodes: [end],
    });

    const { runState } = await setupDurableHarness('sel-det', 'sel-det-run');
    runState.messages = [{ role: 'user', content: 'I have a billing question about my invoice' }];

    const result = await selectHostTarget({
      agent: {
        id: 'router',
        flows: [faq, billing],
        routes: [{ flow: 'billing', when: 'billing invoice payment' }],
      },
      run: runState,
      model: {} as LanguageModel,
    });

    expect(llmCalled).toBe(false);
    expect(result).toEqual({ kind: 'enterFlow', flow: billing });
  });

  it('selectHostTarget calls generateObject when deterministic match is ambiguous', async () => {
    let llmCalled = false;
    mock.module('ai', () => {
      const actual = require('ai');
      return {
        ...actual,
        generateObject: async () => {
          llmCalled = true;
          return {
            object: { action: 'keep', flowName: null, agentId: null, reason: null },
          };
        },
      };
    });

    const end = reply({ id: 'end', instructions: 'done', next: () => ({ end: 'ok' }) });
    const billing = defineFlow({
      name: 'billing',
      description: 'Billing',
      start: end,
      nodes: [end],
    });
    const faq = defineFlow({
      name: 'faq',
      description: 'FAQ',
      start: end,
      nodes: [end],
    });

    const { runState } = await setupDurableHarness('sel-ambig', 'sel-ambig-run');
    runState.messages = [{ role: 'user', content: 'hello there' }];

    await selectHostTarget({
      agent: {
        id: 'router',
        flows: [faq, billing],
        routes: [
          { flow: 'billing', when: 'billing invoice' },
          { flow: 'faq', when: 'faq help' },
        ],
      },
      run: runState,
      model: {} as LanguageModel,
    });

    expect(llmCalled).toBe(true);
  });
});

describe('matchChoiceFromInput', () => {
  const choices = [
    { id: 'checkout', label: 'Checkout' },
    { id: 'more', label: 'Add another gift' },
  ];

  it('matches exact id and label', () => {
    expect(matchChoiceFromInput('checkout', choices)).toBe('checkout');
    expect(matchChoiceFromInput('Add another gift', choices)).toBe('more');
  });

  it('matches a single clear keyword', () => {
    expect(matchChoiceFromInput('please checkout now', choices)).toBe('checkout');
  });

  it('returns undefined for none or ambiguous matches', () => {
    expect(matchChoiceFromInput('gift please', choices)).toBeUndefined();
    expect(matchChoiceFromInput('checkout and another', choices)).toBeUndefined();
    expect(matchChoiceFromInput('', choices)).toBeUndefined();
  });
});
