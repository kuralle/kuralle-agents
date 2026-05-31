import type { VectorFilter } from '../types.js';
import { UnsupportedFilterOperatorError } from './errors.js';

export type SqlWhereResult = {
  /** Rendered WHERE clause body (empty when `filter` is undefined or trivial). */
  whereClause: string;
  /** Positional parameters to bind into the prepared statement. */
  params: unknown[];
};

const SUPPORTED_OPS = new Set([
  '$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in', '$nin', '$exists',
]);

const escapeField = (field: string): string => field.replace(/'/g, "''");

/**
 * Translate Kuralle's MongoDB-style `VectorFilter` into a PostgreSQL WHERE
 * clause targeting a `metadata JSONB` column. Values are parameterized;
 * operators not in the supported set throw `UnsupportedFilterOperatorError`.
 *
 * @param filter MongoDB-style filter.
 * @param startParamIndex First positional parameter index (defaults to 1).
 *   Pass `n+1` when the caller has already bound `n` parameters upstream.
 */
export function toSqlWhere(
  filter?: VectorFilter,
  startParamIndex = 1,
): SqlWhereResult {
  if (!filter) return { whereClause: '', params: [] };
  const ctx = { params: [] as unknown[], counter: startParamIndex - 1 };
  const clause = translate(filter, ctx);
  return { whereClause: clause, params: ctx.params };
}

type Ctx = { params: unknown[]; counter: number };

function translate(filter: VectorFilter, ctx: Ctx): string {
  if ('$and' in filter) {
    const clauses = (filter.$and as VectorFilter[]).map(f => translate(f, ctx));
    return `(${clauses.join(' AND ')})`;
  }
  if ('$or' in filter) {
    const clauses = (filter.$or as VectorFilter[]).map(f => translate(f, ctx));
    return `(${clauses.join(' OR ')})`;
  }
  if ('$not' in filter) {
    return `NOT (${translate(filter.$not as VectorFilter, ctx)})`;
  }

  const conditions: string[] = [];
  for (const [field, condition] of Object.entries(filter)) {
    if (condition === null || condition === undefined) {
      conditions.push(`metadata->>'${escapeField(field)}' IS NULL`);
      continue;
    }

    if (typeof condition === 'object' && !Array.isArray(condition)) {
      const ops = condition as Record<string, unknown>;
      for (const [op, value] of Object.entries(ops)) {
        if (!SUPPORTED_OPS.has(op)) {
          throw new UnsupportedFilterOperatorError({
            backend: 'postgres',
            operator: op,
            reason: 'use $eq, $ne, $gt, $gte, $lt, $lte, $in, $nin, or $exists',
          });
        }
        conditions.push(renderOp(field, op, value, ctx));
      }
      continue;
    }

    const idx = ++ctx.counter;
    ctx.params.push(condition);
    conditions.push(`metadata->>'${escapeField(field)}' = $${idx}::text`);
  }

  return conditions.length > 0 ? conditions.join(' AND ') : 'TRUE';
}

function renderOp(field: string, op: string, value: unknown, ctx: Ctx): string {
  const col = `metadata->>'${escapeField(field)}'`;

  switch (op) {
    case '$eq': {
      const idx = ++ctx.counter;
      ctx.params.push(value);
      return `${col} = $${idx}::text`;
    }
    case '$ne': {
      const idx = ++ctx.counter;
      ctx.params.push(value);
      return `${col} != $${idx}::text`;
    }
    case '$gt': case '$gte': case '$lt': case '$lte': {
      const idx = ++ctx.counter;
      ctx.params.push(value);
      const sqlOp = { $gt: '>', $gte: '>=', $lt: '<', $lte: '<=' }[op as '$gt' | '$gte' | '$lt' | '$lte'];
      return `(${col})::numeric ${sqlOp} $${idx}::numeric`;
    }
    case '$in': case '$nin': {
      const arr = value as unknown[];
      const placeholders = arr.map(v => {
        const pi = ++ctx.counter;
        ctx.params.push(v);
        return `$${pi}::text`;
      });
      return `${col} ${op === '$in' ? 'IN' : 'NOT IN'} (${placeholders.join(', ')})`;
    }
    case '$exists':
      return value
        ? `metadata ? '${escapeField(field)}'`
        : `NOT (metadata ? '${escapeField(field)}')`;
    default:
      throw new UnsupportedFilterOperatorError({ backend: 'postgres', operator: op });
  }
}
