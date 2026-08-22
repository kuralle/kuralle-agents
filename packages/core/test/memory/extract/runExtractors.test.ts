import { describe, expect, it, mock, afterEach } from 'bun:test';
import { MockLanguageModelV3 } from 'ai/test';
import { z } from 'zod';
import { defineExtractor } from '../../../src/memory/extract/defineExtractor.js';
import { InMemoryExtractedValueStore } from '../../../src/memory/extract/InMemoryExtractedValueStore.js';
import { runExtractors } from '../../../src/memory/extract/runExtractors.js';
import type { StreamPart } from '../../../src/types/stream.js';
import {
  mockV3GenerateResult,
  extractSystemFromPrompt,
  nonSystemMessages,
  extractPromptText,
  type GenerateObjectCall,
} from '../../helpers/mockLanguageModelV3Results.js';

afterEach(() => {
  mock.restore();
});

const baseCtx = {
  agentId: 'agent-1',
  sessionId: 'session-1',
  userId: 'user-1',
};

type CapturedGenerateCall = GenerateObjectCall & {
  jsonSchema?: {
    properties?: Record<string, unknown>;
    required?: string[];
  };
};

function mockGenerateObject(
  impl: (opts: GenerateObjectCall) => Promise<{ object: Record<string, unknown> }>,
): { model: MockLanguageModelV3; calls: CapturedGenerateCall[] } {
  const calls: CapturedGenerateCall[] = [];
  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      const prompt = options.prompt ?? [];
      const callOpts: CapturedGenerateCall = {
        system: extractSystemFromPrompt(prompt),
        messages: nonSystemMessages(prompt),
        promptText: extractPromptText(prompt),
        jsonSchema:
          options.responseFormat?.type === 'json'
            ? (options.responseFormat.schema as CapturedGenerateCall['jsonSchema'])
            : undefined,
      };
      calls.push(callOpts);
      const { object } = await impl(callOpts);
      return mockV3GenerateResult(JSON.stringify(object));
    },
  });
  return { model, calls };
}

function collectEmit() {
  const parts: StreamPart[] = [];
  return {
    emit: (part: StreamPart) => {
      parts.push(part);
    },
    parts,
  };
}

describe('runExtractors', () => {
  it('issues one generateObject whose schema keeps every slug required-but-nullable', async () => {
    const { model, calls } = mockGenerateObject(async () => ({
      object: {
        'favorite-color': 'blue',
        'home-city': 'Paris',
        'job-title': 'engineer',
      },
    }));

    const extractors = [
      defineExtractor({
        name: 'Favorite Color',
        instructions: 'Extract favorite color.',
        schema: z.string(),
      }),
      defineExtractor({
        name: 'Home City',
        instructions: 'Extract home city.',
        schema: z.string(),
      }),
      defineExtractor({
        name: 'Job Title',
        instructions: 'Extract job title.',
        schema: z.string(),
      }),
    ];

    const store = new InMemoryExtractedValueStore();
    const { emit } = collectEmit();
    const result = await runExtractors({
      extractors,
      store,
      model,
      messages: [{ role: 'user', content: 'I live in Paris and work as an engineer.' }],
      ctx: { ...baseCtx, emit },
    });

    expect(calls).toHaveLength(1);
    const json = calls[0]!.jsonSchema!;
    for (const slug of ['favorite-color', 'home-city', 'job-title']) {
      expect(json.properties![slug]).toBeDefined();
      expect(json.required).toContain(slug);
      const prop = json.properties![slug] as { anyOf?: Array<{ type: string }> };
      expect(prop.anyOf?.some((entry) => entry.type === 'null')).toBe(true);
    }
    expect(result.failures).toHaveLength(0);
    expect(Object.keys(result.values).sort()).toEqual(['favorite-color', 'home-city', 'job-title']);
  });

  it('includes prior values in the prompt only for includePrevious extractors', async () => {
    const store = new InMemoryExtractedValueStore();
    await store.save(
      {
        slug: 'with-prior',
        scope: 'user',
        value: 'kept-value',
        updatedAt: '2026-08-06T00:00:00.000Z',
      },
      'user-1',
    );
    await store.save(
      {
        slug: 'without-prior',
        scope: 'user',
        value: 'hidden-value',
        updatedAt: '2026-08-06T00:00:00.000Z',
      },
      'user-1',
    );

    const { model, calls } = mockGenerateObject(async () => ({
      object: { 'with-prior': 'kept-value', 'without-prior': 'new-value' },
    }));

    const extractors = [
      defineExtractor({
        name: 'With Prior',
        instructions: 'Extract with prior.',
        schema: z.string(),
        includePrevious: true,
      }),
      defineExtractor({
        name: 'Without Prior',
        instructions: 'Extract without prior.',
        schema: z.string(),
        includePrevious: false,
      }),
    ];

    const { emit } = collectEmit();
    await runExtractors({
      extractors,
      store,
      model,
      messages: [{ role: 'user', content: 'hello' }],
      ctx: { ...baseCtx, emit },
    });

    const system = calls[0]?.system ?? '';
    expect(system).toContain('with-prior');
    expect(system).toContain('kept-value');
    expect(system).not.toContain('hidden-value');
  });

  it('records generateObject validation failures for every slug', async () => {
    const { model } = mockGenerateObject(async () => ({
      object: {
        good: 'ok',
        bad: 123,
        'also-good': 'yes',
      },
    }));

    const extractors = [
      defineExtractor({ name: 'Good', instructions: 'good', schema: z.string() }),
      defineExtractor({ name: 'Bad', instructions: 'bad', schema: z.string() }),
      defineExtractor({ name: 'Also Good', instructions: 'also', schema: z.string() }),
    ];

    const store = new InMemoryExtractedValueStore();
    const { emit } = collectEmit();
    const result = await runExtractors({
      extractors,
      store,
      model,
      messages: [{ role: 'user', content: 'data' }],
      ctx: { ...baseCtx, emit },
    });

    expect(result.failures).toHaveLength(3);
    expect(result.values).toEqual({});
    expect(await store.load('user', 'user-1', 'good')).toBeNull();
  });

  it('persists onExtracted replacement, not the raw model value', async () => {
    const { model } = mockGenerateObject(async () => ({ object: { profile: { n: 1 } } }));

    const extractors = [
      defineExtractor({
        name: 'Profile',
        instructions: 'profile',
        schema: z.object({ n: z.number() }),
        onExtracted: () => ({ n: 99 }),
      }),
    ];

    const store = new InMemoryExtractedValueStore();
    const { emit } = collectEmit();
    const result = await runExtractors({
      extractors,
      store,
      model,
      messages: [{ role: 'user', content: 'x' }],
      ctx: { ...baseCtx, emit },
    });

    expect(result.values.profile).toEqual({ n: 99 });
    expect((await store.load('user', 'user-1', 'profile'))?.value).toEqual({ n: 99 });
  });

  it('records onExtracted throws as failures and persists nothing for that slug', async () => {
    const { model } = mockGenerateObject(async () => ({ object: { flaky: 'raw', stable: 'kept' } }));

    const extractors = [
      defineExtractor({
        name: 'Flaky',
        instructions: 'flaky',
        schema: z.string(),
        onExtracted: () => {
          throw new Error('hook rejected');
        },
      }),
      defineExtractor({
        name: 'Stable',
        instructions: 'stable',
        schema: z.string(),
      }),
    ];

    const store = new InMemoryExtractedValueStore();
    const { emit } = collectEmit();
    const result = await runExtractors({
      extractors,
      store,
      model,
      messages: [{ role: 'user', content: 'x' }],
      ctx: { ...baseCtx, emit },
    });

    expect(result.failures).toEqual([{ slug: 'flaky', error: 'hook rejected' }]);
    expect(result.values).toEqual({ stable: 'kept' });
    expect(await store.load('user', 'user-1', 'flaky')).toBeNull();
    expect((await store.load('user', 'user-1', 'stable'))?.value).toBe('kept');
  });

  it('with persist false emits extraction but writes no store row', async () => {
    const { model } = mockGenerateObject(async () => ({ object: { ephemeral: 'value' } }));

    const extractors = [
      defineExtractor({
        name: 'Ephemeral',
        instructions: 'ephemeral',
        schema: z.string(),
        persist: false,
      }),
    ];

    const store = new InMemoryExtractedValueStore();
    const { emit, parts } = collectEmit();
    const result = await runExtractors({
      extractors,
      store,
      model,
      messages: [{ role: 'user', content: 'x' }],
      ctx: { ...baseCtx, emit },
    });

    expect(result.values).toEqual({ ephemeral: 'value' });
    expect(await store.load('user', 'user-1', 'ephemeral')).toBeNull();
    expect(parts.filter((p) => p.type === 'extraction')).toEqual([
      {
        channel: 'internal',
        type: 'extraction',
        payload: { slug: 'ephemeral', value: 'value', changed: true },
      },
    ]);
  });

  it('leaves prior store values intact when the model omits a slug', async () => {
    const store = new InMemoryExtractedValueStore();
    await store.save(
      {
        slug: 'unchanged',
        scope: 'user',
        value: 'still-here',
        updatedAt: '2026-08-06T00:00:00.000Z',
      },
      'user-1',
    );

    const { model } = mockGenerateObject(async () => ({
      object: { unchanged: null, other: 'new' },
    }));

    const extractors = [
      defineExtractor({ name: 'Unchanged', instructions: 'u', schema: z.string() }),
      defineExtractor({ name: 'Other', instructions: 'o', schema: z.string() }),
    ];

    const { emit } = collectEmit();
    const result = await runExtractors({
      extractors,
      store,
      model,
      messages: [{ role: 'user', content: 'only other mentioned' }],
      ctx: { ...baseCtx, emit },
    });

    expect(result.values).toEqual({ other: 'new' });
    expect((await store.load('user', 'user-1', 'unchanged'))?.value).toBe('still-here');
  });

  it('skips extractors with no resolvable owner and records a failure', async () => {
    const { model, calls } = mockGenerateObject(async () => ({ object: { 'agent-scoped': 'x' } }));

    const extractors = [
      defineExtractor({
        name: 'User Scoped',
        instructions: 'needs user',
        schema: z.string(),
        scope: 'user',
      }),
      defineExtractor({
        name: 'Agent Scoped',
        instructions: 'agent ok',
        schema: z.string(),
        scope: 'agent',
      }),
    ];

    const store = new InMemoryExtractedValueStore();
    const { emit } = collectEmit();
    const result = await runExtractors({
      extractors,
      store,
      model,
      messages: [{ role: 'user', content: 'x' }],
      ctx: { agentId: 'agent-1', sessionId: 'session-1', emit },
    });

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]!.slug).toBe('user-scoped');
    expect(result.values).toEqual({ 'agent-scoped': 'x' });
    expect(calls).toHaveLength(1);
    const json = calls[0]!.jsonSchema!;
    expect(json.properties!['user-scoped']).toBeUndefined();
    expect(json.properties!['agent-scoped']).toBeDefined();
  });

  it('does not emit extraction when the value is unchanged', async () => {
    const store = new InMemoryExtractedValueStore();
    await store.save(
      {
        slug: 'same',
        scope: 'user',
        value: 'unchanged',
        updatedAt: '2026-08-06T00:00:00.000Z',
      },
      'user-1',
    );

    const { model } = mockGenerateObject(async () => ({ object: { same: 'unchanged' } }));

    const extractors = [
      defineExtractor({ name: 'Same', instructions: 'same', schema: z.string() }),
    ];

    const { emit, parts } = collectEmit();
    await runExtractors({
      extractors,
      store,
      model,
      messages: [{ role: 'user', content: 'x' }],
      ctx: { ...baseCtx, emit },
    });

    expect(parts.filter((p) => p.type === 'extraction')).toHaveLength(0);
  });

  it('never throws when generateObject fails', async () => {
    const { model } = mockGenerateObject(async () => {
      throw new Error('model down');
    });

    const extractors = [
      defineExtractor({ name: 'One', instructions: 'one', schema: z.string() }),
    ];

    const store = new InMemoryExtractedValueStore();
    const { emit } = collectEmit();
    const result = await runExtractors({
      extractors,
      store,
      model,
      messages: [{ role: 'user', content: 'x' }],
      ctx: { ...baseCtx, emit },
    });

    expect(result.values).toEqual({});
    expect(result.failures).toEqual([{ slug: 'one', error: 'model down' }]);
  });
});

describe('runExtractors partial-success guard', () => {
  it('keeps prior values out of the cacheable stable prefix', async () => {
    const seen: Array<{ stable: string; volatile: string }> = [];
    const promptCache = await import('../../../src/runtime/promptCache.js');
    const realApply = promptCache.applyPromptCache;
    mock.module('../../../src/runtime/promptCache.js', () => ({
      ...promptCache,
      applyPromptCache: (opts: Parameters<typeof realApply>[0]) => {
        seen.push({
          stable: (opts.stableSystem ?? []).map((m) => String(m.content ?? '')).join('\n'),
          volatile: (opts.volatileSystemBlocks ?? []).join('\n'),
        });
        return realApply(opts);
      },
    }));

    const store = new InMemoryExtractedValueStore();
    await store.save(
      { slug: 'profile', scope: 'user', value: 'SECRET-PRIOR', updatedAt: '2026-08-06T00:00:00.000Z' },
      'user-1',
    );
    const { model } = mockGenerateObject(async () => ({ object: { profile: 'next' } }));
    const { emit } = collectEmit();

    await runExtractors({
      extractors: [
        defineExtractor({
          name: 'Profile',
          instructions: 'Extract the profile.',
          schema: z.string(),
          includePrevious: true,
        }),
      ],
      store,
      model,
      messages: [{ role: 'user', content: 'hello' }],
      ctx: { ...baseCtx, emit },
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]!.volatile).toContain('SECRET-PRIOR');
    expect(seen[0]!.stable).not.toContain('SECRET-PRIOR');
  });

  it('emits a JSON Schema with every slug in `required`, which OpenAI demands', async () => {
    const { model, calls } = mockGenerateObject(async () => ({ object: { alpha: null, beta: null } }));
    const { emit } = collectEmit();
    await runExtractors({
      extractors: [
        defineExtractor({ name: 'Alpha', instructions: 'a', schema: z.string() }),
        defineExtractor({ name: 'Beta', instructions: 'b', schema: z.object({ n: z.number() }) }),
      ],
      store: new InMemoryExtractedValueStore(),
      model,
      messages: [{ role: 'user', content: 'hi' }],
      ctx: { ...baseCtx, emit },
    });

    const json = calls[0]!.jsonSchema!;
    expect(Object.keys(json.properties ?? {}).sort()).toEqual(['alpha', 'beta']);
    expect((json.required ?? []).sort()).toEqual(['alpha', 'beta']);
  });
});
