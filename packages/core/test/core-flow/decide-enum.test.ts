import { describe, expect, it } from 'bun:test';
import { MockLanguageModelV3 } from 'ai/test';
import { z } from 'zod';
import { decide } from '../../src/types/flow.js';
import {
  CHOICE_NONE,
  buildChoiceEnumSchema,
  matchChoiceFromInput,
} from '../../src/flow/choiceMatch.js';
import { TextDriver } from '../../src/runtime/channels/TextDriver.js';
import { createRunContext } from '../../src/runtime/ctx.js';
import { CoreToolExecutor } from '../../src/tools/effect/index.js';
import { selectHostTarget } from '../../src/runtime/select.js';
import { defineFlow, reply } from '../../src/types/flow.js';
import { setupDurableHarness } from '../core-durable/helpers.js';
import {
  mockV3GenerateObjectModel,
  mockV3GenerateResult,
} from '../helpers/mockLanguageModelV3Results.js';

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

function llmGuardModel(onCall: () => void): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async () => {
      onCall();
      throw new Error('LLM should not run');
    },
  });
}

function jsonSchemaEnum(responseFormat: unknown): string[] | undefined {
  if (!responseFormat || typeof responseFormat !== 'object') return undefined;
  const schema = (responseFormat as { schema?: { properties?: { choice?: { enum?: string[] } } } })
    .schema;
  return schema?.properties?.choice?.enum;
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
    const model = new MockLanguageModelV3({
      doGenerate: async () => mockV3GenerateResult(JSON.stringify({ choice: CHOICE_NONE })),
    });

    const { session, runStore, runState } = await setupDurableHarness('enum-schema', 'enum-schema-run');
    runState.messages = [{ role: 'user', content: 'something unrelated entirely' }];
    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model,
      emit: () => {},
    });

    await new TextDriver().runStructured(choiceDecideNode(), ctx);

    const enumValues = jsonSchemaEnum(model.doGenerateCalls[0]?.responseFormat);
    expect(enumValues).toContain('checkout');
    expect(enumValues).toContain('more');
    expect(enumValues).toContain(CHOICE_NONE);
    expect(enumValues).not.toContain('not-a-real-id');
  });

  it('exact id match skips generateObject', async () => {
    let llmCalled = false;
    const model = llmGuardModel(() => {
      llmCalled = true;
    });

    const { session, runStore, runState } = await setupDurableHarness('code-first-id', 'code-first-id-run');
    runState.messages = [{ role: 'user', content: 'checkout' }];
    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model,
      emit: () => {},
    });

    const result = await new TextDriver().runStructured(choiceDecideNode(), ctx);
    expect(result).toEqual({ choice: 'checkout' });
    expect(llmCalled).toBe(false);
  });

  it('exact label match skips generateObject', async () => {
    let llmCalled = false;
    const model = llmGuardModel(() => {
      llmCalled = true;
    });

    const { session, runStore, runState } = await setupDurableHarness('code-first-label', 'code-first-label-run');
    runState.messages = [{ role: 'user', content: 'Add another gift' }];
    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model,
      emit: () => {},
    });

    const result = await new TextDriver().runStructured(choiceDecideNode(), ctx);
    expect(result).toEqual({ choice: 'more' });
    expect(llmCalled).toBe(false);
  });

  it('ambiguous input falls through to constrained generateObject', async () => {
    let llmCalled = false;
    const model = mockV3GenerateObjectModel(async () => {
      llmCalled = true;
      return { object: { choice: 'checkout' } };
    });

    const { session, runStore, runState } = await setupDurableHarness('ambig', 'ambig-run');
    runState.messages = [{ role: 'user', content: 'something unrelated entirely' }];
    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model,
      emit: () => {},
    });

    const result = await new TextDriver().runStructured(choiceDecideNode(), ctx);
    expect(llmCalled).toBe(true);
    expect(result).toEqual({ choice: 'checkout' });
  });

  it('__none from the model maps to stay via decide', async () => {
    const model = mockV3GenerateObjectModel(async () => ({ object: { choice: CHOICE_NONE } }));

    const node = choiceDecideNode();
    const { session, runStore, runState } = await setupDurableHarness('none-stay', 'none-stay-run');
    runState.messages = [{ role: 'user', content: 'something unrelated entirely' }];
    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model,
      emit: () => {},
    });

    const structured = await new TextDriver().runStructured(node, ctx);
    const branch = await node.decide!(structured, runState.state);
    expect(branch).toBe('stay');
  });

  it('custom non-choice schema keeps legacy unconstrained generateObject', async () => {
    const model = new MockLanguageModelV3({
      doGenerate: async () => mockV3GenerateResult(JSON.stringify({ action: 'hold' })),
    });

    const node = decide({
      id: 'custom',
      instructions: 'Classify',
      schema: z.object({ action: z.enum(['hold', 'cancel']) }),
      decide: () => 'stay',
    });
    node.choices = [{ id: 'hold', label: 'Hold' }];

    const { session, runStore, runState } = await setupDurableHarness('custom-schema', 'custom-schema-run');
    runState.messages = [{ role: 'user', content: 'hold please' }];
    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model,
      emit: () => {},
    });

    await new TextDriver().runStructured(node, ctx);
    const responseFormat = model.doGenerateCalls[0]?.responseFormat as
      | { schema?: { properties?: { action?: unknown; choice?: unknown } } }
      | undefined;
    expect(responseFormat?.schema?.properties?.action).toBeDefined();
    expect(responseFormat?.schema?.properties?.choice).toBeUndefined();
  });

  it('classifyHostTarget always uses generateObject (no lexical routing)', async () => {
    const model = mockV3GenerateObjectModel(async () => ({
      object: {
        action: 'enterFlow',
        flowName: 'billing',
        agentId: null,
        reason: 'billing',
        confidence: 0.9,
      },
    }));

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

    const { classifyHostTarget } = await import('../../src/runtime/select.js');
    const result = await classifyHostTarget({
      agent: {
        id: 'router',
        flows: [faq, billing],
        routes: [{ flow: 'billing', when: 'billing invoice payment' }],
      },
      run: runState,
      model,
      allowKeep: true,
    });

    expect(model.doGenerateCalls.length).toBeGreaterThan(0);
    expect(result.action).toBe('enterFlow');
    expect(result.flowName).toBe('billing');
  });

  it('selectHostTarget calls generateObject for routing decisions', async () => {
    const model = mockV3GenerateObjectModel(async () => ({
      object: {
        action: 'keep',
        flowName: null,
        agentId: null,
        reason: null,
        confidence: null,
      },
    }));

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
      model,
    });

    expect(model.doGenerateCalls.length).toBeGreaterThan(0);
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
