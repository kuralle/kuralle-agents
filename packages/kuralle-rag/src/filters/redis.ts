import type { VectorFilter } from '../types.js';
import { UnsupportedFilterOperatorError } from './errors.js';

/**
 * Ops that Redis Search's basic TAG syntax can express directly. Anything
 * outside this set must be widened at the adapter level (post-filter) or
 * requires a future Redis Search extension. Throws rather than silently
 * dropping, so callers learn about the limitation.
 */
const SUPPORTED_OPS = new Set(['$eq', '$in']);

/**
 * Translate Kuralle's MongoDB-style `VectorFilter` into Redis Search filter
 * syntax. Redis Search supports only `$eq` and `$in` in the basic TAG form;
 * unsupported operators throw `UnsupportedFilterOperatorError`.
 *
 * Returns `'*'` when the filter is empty — matches Redis's "all documents"
 * wildcard.
 */
export function toRedisFilter(filter?: VectorFilter): string {
  if (!filter) return '*';

  if ('$and' in filter) {
    const clauses = (filter.$and as VectorFilter[]).map(toRedisFilter);
    return clauses.join(' ');
  }
  if ('$or' in filter) {
    const clauses = (filter.$or as VectorFilter[]).map(toRedisFilter);
    return `(${clauses.join(' | ')})`;
  }
  if ('$not' in filter) {
    const clause = toRedisFilter(filter.$not as VectorFilter);
    return `-${clause}`;
  }

  const conditions: string[] = [];
  for (const [, condition] of Object.entries(filter)) {
    if (typeof condition === 'object' && condition !== null && !Array.isArray(condition)) {
      const ops = condition as Record<string, unknown>;
      for (const op of Object.keys(ops)) {
        if (!SUPPORTED_OPS.has(op)) {
          throw new UnsupportedFilterOperatorError({
            backend: 'redis',
            operator: op,
            reason: 'Redis Search basic TAG filter supports only $eq and $in',
          });
        }
      }
      if ('$eq' in ops) {
        conditions.push(`@metadata:(${escapeRedis(String(ops.$eq))})`);
      }
      if ('$in' in ops) {
        const vals = (ops.$in as unknown[]).map(v => escapeRedis(String(v)));
        conditions.push(`@metadata:(${vals.join('|')})`);
      }
    } else if (condition !== null && condition !== undefined) {
      conditions.push(`@metadata:(${escapeRedis(String(condition))})`);
    }
  }

  return conditions.length > 0 ? conditions.join(' ') : '*';
}

function escapeRedis(value: string): string {
  return value.replace(/[,.<>{}[\]"':;!@#$%^&*()+=~|/\\-]/g, '\\$&');
}
