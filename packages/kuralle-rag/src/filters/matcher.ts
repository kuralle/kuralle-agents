import type { VectorFilter } from '../types.js';

/**
 * In-memory evaluator for the canonical `VectorFilter` shape.
 *
 * Runs a MongoDB-style filter against a plain metadata record and returns
 * whether the record matches. Used by in-process vector stores
 * (`InMemoryVectorStore`) and any downstream adapter that must re-filter
 * results after a backend-level query — e.g. when the backend supports
 * only a subset of operators and the remainder must be applied in memory.
 *
 * Operator coverage matches the translators in `./sql.ts`, `./lancedb.ts`,
 * and peers: `$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`, `$nin`,
 * `$exists`, plus the logical combinators `$and`, `$or`, `$not`.
 */
export function matchFilter(
  metadata: Record<string, unknown>,
  filter: VectorFilter,
): boolean {
  if ('$and' in filter) {
    return (filter.$and as VectorFilter[]).every(f => matchFilter(metadata, f));
  }
  if ('$or' in filter) {
    return (filter.$or as VectorFilter[]).some(f => matchFilter(metadata, f));
  }
  if ('$not' in filter) {
    return !matchFilter(metadata, filter.$not as VectorFilter);
  }

  for (const [field, condition] of Object.entries(filter)) {
    const value = metadata[field];
    if (condition === null || condition === undefined) {
      if (value !== condition) return false;
      continue;
    }

    if (typeof condition === 'object' && !Array.isArray(condition)) {
      const ops = condition as Record<string, unknown>;
      if ('$eq' in ops && value !== ops.$eq) return false;
      if ('$ne' in ops && value === ops.$ne) return false;
      if ('$gt' in ops && (typeof value !== 'number' || value <= (ops.$gt as number))) return false;
      if ('$gte' in ops && (typeof value !== 'number' || value < (ops.$gte as number))) return false;
      if ('$lt' in ops && (typeof value !== 'number' || value >= (ops.$lt as number))) return false;
      if ('$lte' in ops && (typeof value !== 'number' || value > (ops.$lte as number))) return false;
      if ('$in' in ops && !(ops.$in as unknown[]).includes(value)) return false;
      if ('$nin' in ops && (ops.$nin as unknown[]).includes(value)) return false;
      if ('$exists' in ops) {
        const exists = value !== undefined;
        if (ops.$exists !== exists) return false;
      }
      continue;
    }

    if (value !== condition) return false;
  }
  return true;
}
