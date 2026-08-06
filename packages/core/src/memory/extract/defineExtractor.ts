import { ZodType } from 'zod';
import type { MemoryBlockScope } from '../blocks/types.js';
import type { Extractor, ExtractorRuntimeContext, ResolvedExtractor } from './types.js';

/** Slugs reserved by other memory subsystems — an extractor may not claim one. */
export const RESERVED_EXTRACTOR_SLUGS: ReadonlySet<string> = new Set(['facts', 'summary', 'working-memory']);

/** Slugs longer than this are rejected — a live risk as a persistence key (file path / DB index). */
export const MAX_SLUG_LENGTH = 64;

const SLUG_PATTERN = /^[a-z](?:[a-z0-9-]*[a-z0-9])?$/;
const COMBINING_MARKS_PATTERN = /[\u0300-\u036f]/g;

/** Throws when `slug` is not lowercase alphanumerics/hyphens starting with a letter and ending alphanumeric. */
export function assertValidSlug(slug: string, sourceName: string): void {
  if (!SLUG_PATTERN.test(slug)) {
    throw new Error(
      `[Kuralle] extractor name "${sourceName}" produced an invalid slug "${slug}" — slugs must be ` +
        'lowercase alphanumerics and hyphens, starting with a letter and ending alphanumeric.',
    );
  }
  if (slug.length > MAX_SLUG_LENGTH) {
    throw new Error(
      `[Kuralle] extractor name "${sourceName}" produced a slug "${slug}" longer than ` +
        `${MAX_SLUG_LENGTH} characters.`,
    );
  }
}

/** Throws when `slug` matches a reserved key claimed by another memory subsystem. */
export function assertNotReservedSlug(slug: string, sourceName: string): void {
  if (RESERVED_EXTRACTOR_SLUGS.has(slug)) {
    throw new Error(
      `[Kuralle] extractor "${sourceName}" resolves to reserved slug "${slug}" ` +
        `(reserved: ${[...RESERVED_EXTRACTOR_SLUGS].join(', ')}).`,
    );
  }
}

/**
 * Derives an extractor slug from its display name: NFKD-normalised (so accents and
 * fullwidth forms fold to their plain-ASCII base — 'Café' -> 'cafe', '２' -> '2' —
 * rather than being silently dropped), lowercased, non-alphanumerics collapsed to
 * `-`, trimmed.
 */
export function slugifyExtractorName(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(COMBINING_MARKS_PATTERN, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  assertValidSlug(slug, name);
  return slug;
}

/** Rejects duplicate slugs, naming both extractors that collided. */
export function validateExtractorList(extractors: readonly Extractor<never>[]): Extractor<never>[] {
  const bySlug = new Map<string, Extractor<never>[]>();
  for (const extractor of extractors) {
    const group = bySlug.get(extractor.slug);
    if (group) {
      group.push(extractor);
    } else {
      bySlug.set(extractor.slug, [extractor]);
    }
  }
  for (const [slug, group] of bySlug) {
    if (group.length > 1) {
      throw new Error(
        `[Kuralle] duplicate extractor slug "${slug}" claimed by ${group
          .map((e) => `"${e.name}"`)
          .join(' and ')}.`,
      );
    }
  }
  return extractors as Extractor<never>[];
}

export interface DefineExtractorConfig<T> {
  name: string;
  instructions: Extractor<T>['instructions'];
  schema: Extractor<T>['schema'];
  scope?: MemoryBlockScope;
  includePrevious?: boolean;
  persist?: boolean;
  onExtracted?: Extractor<T>['onExtracted'];
}

export function defineExtractor<T = unknown>(config: DefineExtractorConfig<T>): Extractor<T> {
  const slug = slugifyExtractorName(config.name);
  assertNotReservedSlug(slug, config.name);
  return {
    name: config.name,
    slug,
    instructions: config.instructions,
    schema: config.schema,
    scope: config.scope ?? 'user',
    includePrevious: config.includePrevious ?? true,
    persist: config.persist ?? true,
    onExtracted: config.onExtracted,
  };
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Resolves function-form `instructions`/`schema` against a runtime context into concrete values. */
export async function resolveExtractor<T = unknown>(
  extractor: Extractor<T>,
  ctx: ExtractorRuntimeContext,
): Promise<ResolvedExtractor<T>> {
  let instructions: string;
  try {
    instructions =
      typeof extractor.instructions === 'function' ? await extractor.instructions(ctx) : extractor.instructions;
  } catch (err) {
    throw new Error(
      `[Kuralle] extractor "${extractor.name}" instructions resolver threw: ${describeError(err)}`,
      { cause: err },
    );
  }
  if (typeof instructions !== 'string') {
    throw new Error(
      `[Kuralle] extractor "${extractor.name}" resolved instructions to a non-string value ` +
        `(got ${typeof instructions}).`,
    );
  }

  let schema: ZodType<T>;
  try {
    schema = typeof extractor.schema === 'function' ? await extractor.schema(ctx) : extractor.schema;
  } catch (err) {
    throw new Error(`[Kuralle] extractor "${extractor.name}" schema resolver threw: ${describeError(err)}`, {
      cause: err,
    });
  }
  if (!(schema instanceof ZodType)) {
    throw new Error(`[Kuralle] extractor "${extractor.name}" resolved schema to a non-Zod value.`);
  }

  return {
    ...extractor,
    instructions,
    schema,
  };
}
