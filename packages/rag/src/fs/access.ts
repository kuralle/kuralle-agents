import type { VectorFilter } from '../types.js';

export interface KnowledgeAccessFilter {
  vectorFilter?: VectorFilter;
  allowSlug?(slug: string): boolean;
}

export function combineFilters(
  a?: VectorFilter,
  b?: VectorFilter,
): VectorFilter | undefined {
  if (!a) return b;
  if (!b) return a;
  return { $and: [a, b] };
}

export function slugAllowed(
  slug: string,
  filter?: KnowledgeAccessFilter,
): boolean {
  if (filter?.allowSlug && !filter.allowSlug(slug)) return false;
  return true;
}
