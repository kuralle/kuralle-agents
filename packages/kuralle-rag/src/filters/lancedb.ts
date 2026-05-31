import type { VectorFilter } from '../types.js';
import { UnsupportedFilterOperatorError } from './errors.js';

const SUPPORTED_OPS = new Set([
  '$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in', '$nin', '$exists',
]);

/**
 * Translate Kuralle's MongoDB-style `VectorFilter` into a LanceDB SQL WHERE
 * clause. LanceDB reads metadata as a JSON column via `json_extract`. Returns
 * `null` when the filter contributes no predicates (empty branches).
 *
 * Unsupported operators throw `UnsupportedFilterOperatorError`.
 */
export function toLanceDbWhere(filter?: VectorFilter): string | null {
  if (!filter) return null;

  if ('$and' in filter) {
    const clauses = (filter.$and as VectorFilter[])
      .map(toLanceDbWhere)
      .filter((c): c is string => Boolean(c));
    return clauses.length > 0 ? `(${clauses.join(' AND ')})` : null;
  }
  if ('$or' in filter) {
    const clauses = (filter.$or as VectorFilter[])
      .map(toLanceDbWhere)
      .filter((c): c is string => Boolean(c));
    return clauses.length > 0 ? `(${clauses.join(' OR ')})` : null;
  }
  if ('$not' in filter) {
    const inner = toLanceDbWhere(filter.$not as VectorFilter);
    return inner ? `NOT (${inner})` : null;
  }

  const clauses: string[] = [];
  for (const [field, condition] of Object.entries(filter)) {
    const col = `json_extract(metadata, '$.${field}')`;

    if (condition === null || condition === undefined) {
      clauses.push(`${col} IS NULL`);
      continue;
    }

    if (typeof condition === 'object' && !Array.isArray(condition)) {
      const ops = condition as Record<string, unknown>;
      for (const [op, value] of Object.entries(ops)) {
        if (!SUPPORTED_OPS.has(op)) {
          throw new UnsupportedFilterOperatorError({
            backend: 'lancedb',
            operator: op,
          });
        }
        clauses.push(renderOp(col, op, value));
      }
      continue;
    }

    clauses.push(`${col} = ${sqlVal(condition)}`);
  }

  return clauses.length > 0 ? clauses.join(' AND ') : null;
}

function renderOp(col: string, op: string, value: unknown): string {
  switch (op) {
    case '$eq': return `${col} = ${sqlVal(value)}`;
    case '$ne': return `${col} != ${sqlVal(value)}`;
    case '$gt': return `${col} > ${sqlVal(value)}`;
    case '$gte': return `${col} >= ${sqlVal(value)}`;
    case '$lt': return `${col} < ${sqlVal(value)}`;
    case '$lte': return `${col} <= ${sqlVal(value)}`;
    case '$in': {
      const vals = (value as unknown[]).map(sqlVal).join(', ');
      return `${col} IN (${vals})`;
    }
    case '$nin': {
      const vals = (value as unknown[]).map(sqlVal).join(', ');
      return `${col} NOT IN (${vals})`;
    }
    case '$exists':
      return value ? `${col} IS NOT NULL` : `${col} IS NULL`;
    default:
      throw new UnsupportedFilterOperatorError({ backend: 'lancedb', operator: op });
  }
}

function sqlVal(v: unknown): string {
  if (typeof v === 'string') return `'${v.replace(/'/g, "''")}'`;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (v === null || v === undefined) return 'NULL';
  return `'${String(v).replace(/'/g, "''")}'`;
}
