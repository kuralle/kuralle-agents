import { z, type ZodTypeAny } from 'zod';
import type { LanguageModel, ModelMessage } from 'ai';
import { applyPromptCache } from '../../runtime/promptCache.js';
import { instrumentedGenerateObject } from '../../runtime/channels/instrumentModelCall.js';
import { resolveWorkingMemoryOwner } from '../../runtime/grounding/workingMemory.js';
import type { StreamPart } from '../../types/stream.js';
import { resolveExtractor } from './defineExtractor.js';
import type { ExtractedValueStore } from './store.js';
import type { Extractor, ExtractorRuntimeContext, ResolvedExtractor } from './types.js';

export interface RunExtractorsOptions {
  extractors: readonly Extractor[];
  store: ExtractedValueStore;
  model: LanguageModel;
  messages: ModelMessage[];
  ctx: ExtractorRuntimeContext & { emit: (part: StreamPart) => void };
  abortSignal?: AbortSignal;
}

export interface ExtractionRunResult {
  values: Record<string, unknown>;
  failures: Array<{ slug: string; error: string }>;
}

interface RunnableExtractor {
  extractor: ResolvedExtractor;
  owner: string;
  prior: unknown;
}

const EXTRACTION_SYSTEM = [
  'You extract structured information from a conversation.',
  'For each extractor below, follow its instructions.',
  'When a prior value is still valid, carry it forward unchanged.',
  'Only update a field when the conversation provides new or corrected information.',
  'Omit a field entirely when there is nothing to extract or update this turn.',
].join('\n');

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function valuesEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function systemText(
  system: ReadonlyArray<{ content?: unknown }> | undefined,
): string | undefined {
  if (!system || system.length === 0) return undefined;
  return system.map((m) => String(m.content ?? '')).join('\n\n');
}

function buildInstructionsBlock(extractors: readonly ResolvedExtractor[]): string {
  if (extractors.length === 0) return '';
  const sections = extractors.map(
    (e) => `### ${e.name} (slug: ${e.slug})\n${e.instructions}`,
  );
  return ['EXTRACTORS:', ...sections].join('\n\n');
}

function buildPriorBlock(
  extractors: readonly RunnableExtractor[],
): string | undefined {
  const lines: string[] = [];
  for (const { extractor, prior } of extractors) {
    if (!extractor.includePrevious || prior === undefined) continue;
    lines.push(`${extractor.slug}: ${JSON.stringify(prior)}`);
  }
  if (lines.length === 0) return undefined;
  return [
    'PRIOR EXTRACTED VALUES:',
    'Carry forward any prior value that is still valid; update only when the conversation changes it.',
    ...lines,
  ].join('\n');
}

function buildMergedSchema(extractors: readonly ResolvedExtractor[]): z.ZodObject<Record<string, ZodTypeAny>> {
  const shape: Record<string, ZodTypeAny> = {};
  for (const extractor of extractors) {
    shape[extractor.slug] = extractor.schema.optional();
  }
  return z.object(shape);
}

async function prepareRunnableExtractors(
  extractors: readonly Extractor[],
  ctx: ExtractorRuntimeContext,
  store: ExtractedValueStore,
  failures: Array<{ slug: string; error: string }>,
): Promise<RunnableExtractor[]> {
  const runnable: RunnableExtractor[] = [];

  for (const extractor of extractors) {
    let resolved: ResolvedExtractor;
    try {
      resolved = await resolveExtractor(extractor, ctx);
    } catch (err) {
      failures.push({ slug: extractor.slug, error: describeError(err) });
      continue;
    }

    const owner = resolveWorkingMemoryOwner(resolved.scope, ctx.agentId, ctx.userId);
    if (owner === undefined) {
      failures.push({
        slug: resolved.slug,
        error: `[Kuralle] extractor "${resolved.name}": no resolvable owner for scope "${resolved.scope}"`,
      });
      continue;
    }

    let prior: unknown;
    const loaded = await store.load(resolved.scope, owner, resolved.slug);
    if (loaded) {
      prior = loaded.value;
    }

    runnable.push({ extractor: resolved, owner, prior });
  }

  return runnable;
}

/** Runs all extractors in one merged structured model call; persists per slug on success. */
export async function runExtractors(options: RunExtractorsOptions): Promise<ExtractionRunResult> {
  const { extractors, store, model, messages, ctx, abortSignal } = options;
  const failures: Array<{ slug: string; error: string }> = [];
  const values: Record<string, unknown> = {};

  const runnable = await prepareRunnableExtractors(extractors, ctx, store, failures);
  if (runnable.length === 0) {
    return { values, failures };
  }

  const resolved = runnable.map((r) => r.extractor);
  const schema = buildMergedSchema(resolved);
  const volatileBlocks = [
    buildInstructionsBlock(resolved),
    buildPriorBlock(runnable),
  ].filter((block): block is string => Boolean(block?.trim()));

  const cached = applyPromptCache({
    model,
    sessionId: ctx.sessionId,
    messages,
    stableSystem: [{ role: 'system', content: EXTRACTION_SYSTEM }],
    volatileSystemBlocks: volatileBlocks,
  });

  let object: Record<string, unknown>;
  try {
    object = await instrumentedGenerateObject(ctx, {
      model,
      schema,
      system: systemText(cached.system),
      messages: cached.messages,
      temperature: 0,
      abortSignal,
      controlPath: true,
      ...(cached.providerOptions ? { providerOptions: cached.providerOptions } : {}),
    });
  } catch (err) {
    console.warn('[Kuralle] runExtractors generateObject failed:', describeError(err));
    for (const { extractor } of runnable) {
      failures.push({ slug: extractor.slug, error: describeError(err) });
    }
    return { values, failures };
  }

  for (const { extractor, owner, prior } of runnable) {
    const raw = object[extractor.slug];
    if (raw === null || raw === undefined || raw === '') {
      continue;
    }

    const parsed = extractor.schema.safeParse(raw);
    if (!parsed.success) {
      failures.push({
        slug: extractor.slug,
        error: parsed.error.message,
      });
      continue;
    }

    let value: unknown = parsed.data;

    if (extractor.onExtracted) {
      try {
        const hookCtx = {
          ...ctx,
          extractor,
          previous: prior,
          current: value,
        };
        const replaced = await extractor.onExtracted(hookCtx);
        if (replaced !== undefined) {
          value = replaced;
        }
      } catch (err) {
        failures.push({ slug: extractor.slug, error: describeError(err) });
        continue;
      }
    }

    values[extractor.slug] = value;

    if (extractor.persist) {
      try {
        await store.save(
          {
            slug: extractor.slug,
            scope: extractor.scope,
            value,
            updatedAt: new Date().toISOString(),
          },
          owner,
        );
      } catch (err) {
        failures.push({ slug: extractor.slug, error: describeError(err) });
        delete values[extractor.slug];
        continue;
      }
    }

    const changed = !valuesEqual(value, prior);
    if (changed) {
      ctx.emit({
        channel: 'internal',
        type: 'extraction',
        payload: {
          slug: extractor.slug,
          value,
          changed: true,
        },
      });
    }
  }

  return { values, failures };
}
