import type { ZodTypeAny } from 'zod';
import type { MemoryBlockScope } from '../blocks/types.js';

/** Per-turn context an extractor's function-form `instructions`/`schema` resolve against. */
export interface ExtractorRuntimeContext {
  agentId: string;
  sessionId: string;
  userId?: string;
}

/** Context passed to `onExtracted` — the interceptor that runs after a slug's value resolves. */
export interface ExtractorOnExtractedContext<T = unknown> extends ExtractorRuntimeContext {
  extractor: Extractor<T>;
  previous?: T;
  current: T;
}

/**
 * A named, typed, structured thing to learn from a conversation.
 * Always schema-driven — no Mastra-style tag-scraping `inline` mode.
 */
export interface Extractor<T = unknown> {
  readonly name: string;
  /** Derived from `name` via `slugifyExtractorName`. */
  readonly slug: string;
  readonly instructions: string | ((c: ExtractorRuntimeContext) => string | Promise<string>);
  readonly schema: ZodTypeAny | ((c: ExtractorRuntimeContext) => ZodTypeAny | Promise<ZodTypeAny>);
  readonly scope: MemoryBlockScope;
  /** Include the previously extracted value in the prompt. Default `true`. */
  readonly includePrevious: boolean;
  /** Persist to `PersistentMemoryStore`. `false` = emit + run `onExtracted` only. Default `true`. */
  readonly persist: boolean;
  /** Interceptor: returning a value replaces it before persistence; throwing records a per-slug failure. */
  readonly onExtracted?: (c: ExtractorOnExtractedContext<T>) => Promise<T | void> | T | void;
}

/** An `Extractor` with function-form `instructions`/`schema` resolved to concrete values. */
export interface ResolvedExtractor<T = unknown> extends Omit<Extractor<T>, 'instructions' | 'schema'> {
  instructions: string;
  schema: ZodTypeAny;
}
