import type { ZodType } from 'zod';
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
  readonly schema: ZodType<T> | ((c: ExtractorRuntimeContext) => ZodType<T> | Promise<ZodType<T>>);
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
  schema: ZodType<T>;
}

/**
 * An `Extractor` with its payload type erased.
 *
 * `Extractor<T>` is invariant in `T`: `T` occurs covariantly in `schema`
 * (`ZodType<T>`) and contravariantly in `onExtracted`'s parameter. No concrete `X`
 * makes `Extractor<X>` a supertype of every `Extractor<T>`, so a heterogeneous array
 * cannot be typed as `Extractor<X>[]` for any `X` — `Extractor<never>[]` was an
 * attempt at this and does not compile. TypeScript has no existential types; an
 * explicit, named erasure is the honest encoding, and confining it to this one alias
 * keeps every consumer's own types intact.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyExtractor = Extractor<any>;

/** Resolved form of {@link AnyExtractor} — same erasure via structural pick from the alias. */
export type AnyResolvedExtractor = Omit<AnyExtractor, 'instructions' | 'schema'> &
  Pick<ResolvedExtractor, 'instructions' | 'schema'>;
