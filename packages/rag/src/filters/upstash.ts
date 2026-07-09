import type { VectorFilter } from '../types.js';
import { UnsupportedFilterOperatorError } from './errors.js';

const SUPPORTED_OPS = new Set([
  '$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in',
]);

/**
 * Translate Kuralle's MongoDB-style `VectorFilter` into Upstash Vector's
 * SQL-like string filter (`field = 'value' AND field2 > 5`).
 *
 * Upstash does not support `$nin` / `$exists`. Unsupported operators throw
 * `UnsupportedFilterOperatorError`.
 */
export function toUpstashFilterString(filter?: VectorFilter): string {
  if (!filter) return '';

  if ('$and' in filter) {
    const clauses = (filter.$and as VectorFilter[])
      .map(toUpstashFilterString)
      .filter(Boolean);
    return clauses.length > 0 ? `(${clauses.join(' AND ')})` : '';
  }
  if ('$or' in filter) {
    const clauses = (filter.$or as VectorFilter[])
      .map(toUpstashFilterString)
      .filter(Boolean);
    return clauses.length > 0 ? `(${clauses.join(' OR ')})` : '';
  }
  if ('$not' in filter) {
    const inner = toUpstashFilterString(filter.$not as VectorFilter);
    return inner ? `NOT (${inner})` : '';
  }

  const clauses: string[] = [];
  for (const [field, condition] of Object.entries(filter)) {
    if (condition === null || condition === undefined) {
      clauses.push(`${field} IS NULL`);
      continue;
    }

    if (typeof condition === 'object' && !Array.isArray(condition)) {
      const ops = condition as Record<string, unknown>;
      for (const [op, value] of Object.entries(ops)) {
        if (!SUPPORTED_OPS.has(op)) {
          throw new UnsupportedFilterOperatorError({
            backend: 'upstash',
            operator: op,
            reason: 'upstash supports $eq, $ne, $gt, $gte, $lt, $lte, $in',
          });
        }
        clauses.push(renderOp(field, op, value));
      }
      continue;
    }

    clauses.push(`${field} = ${filterVal(condition)}`);
  }

  return clauses.join(' AND ');
}

function renderOp(field: string, op: string, value: unknown): string {
  switch (op) {
    case '$eq': return `${field} = ${filterVal(value)}`;
    case '$ne': return `${field} != ${filterVal(value)}`;
    case '$gt': return `${field} > ${filterVal(value)}`;
    case '$gte': return `${field} >= ${filterVal(value)}`;
    case '$lt': return `${field} < ${filterVal(value)}`;
    case '$lte': return `${field} <= ${filterVal(value)}`;
    case '$in': {
      const vals = (value as unknown[]).map(filterVal).join(', ');
      return `${field} IN (${vals})`;
    }
    default:
      throw new UnsupportedFilterOperatorError({ backend: 'upstash', operator: op });
  }
}

function filterVal(v: unknown): string {
  if (typeof v === 'string') return `'${v.replace(/'/g, "\\'")}'`;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return String(v);
}
