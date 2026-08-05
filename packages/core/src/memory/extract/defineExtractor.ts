import type { MemoryBlockScope } from '../blocks/types.js';
import type { Extractor, ExtractorRuntimeContext, ResolvedExtractor } from './types.js';

/** Slugs reserved by other memory subsystems — an extractor may not claim one. */
export const RESERVED_EXTRACTOR_SLUGS: ReadonlySet<string> = new Set(['facts', 'summary', 'working-memory']);

const SLUG_PATTERN = /^[a-z](?:[a-z0-9-]*[a-z0-9])?$/;

/** Throws when `slug` is not lowercase alphanumerics/hyphens starting with a letter and ending alphanumeric. */
export function assertValidSlug(slug: string, sourceName: string): void {
  if (!SLUG_PATTERN.test(slug)) {
    throw new Error(
      `[Kuralle] extractor name "${sourceName}" produced an invalid slug "${slug}" — slugs must be ` +
        'lowercase alphanumerics and hyphens, starting with a letter and ending alphanumeric.',
    );
  }
}

/** Derives an extractor slug from its display name: lowercase, non-alphanumerics collapsed to `-`, trimmed. */
export function slugifyExtractorName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  assertValidSlug(slug, name);
  return slug;
}

/**
 * Rejects duplicate slugs (naming both extractors that collided) and any slug
 * colliding with a reserved key (`facts`, `summary`, `working-memory`).
 */
export function validateExtractorList(extractors: readonly Extractor[]): Extractor[] {
  const bySlug = new Map<string, Extractor[]>();
  for (const extractor of extractors) {
    if (RESERVED_EXTRACTOR_SLUGS.has(extractor.slug)) {
      throw new Error(
        `[Kuralle] extractor "${extractor.name}" resolves to reserved slug "${extractor.slug}" ` +
          `(reserved: ${[...RESERVED_EXTRACTOR_SLUGS].join(', ')}).`,
      );
    }
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
  return extractors as Extractor[];
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
  return {
    name: config.name,
    slug: slugifyExtractorName(config.name),
    instructions: config.instructions,
    schema: config.schema,
    scope: config.scope ?? 'user',
    includePrevious: config.includePrevious ?? true,
    persist: config.persist ?? true,
    onExtracted: config.onExtracted,
  };
}

/** Resolves function-form `instructions`/`schema` against a runtime context into concrete values. */
export async function resolveExtractor<T = unknown>(
  extractor: Extractor<T>,
  ctx: ExtractorRuntimeContext,
): Promise<ResolvedExtractor<T>> {
  const instructions =
    typeof extractor.instructions === 'function' ? await extractor.instructions(ctx) : extractor.instructions;
  const schema = typeof extractor.schema === 'function' ? await extractor.schema(ctx) : extractor.schema;
  return {
    ...extractor,
    instructions,
    schema,
  };
}
