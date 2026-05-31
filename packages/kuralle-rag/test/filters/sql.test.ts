import { describe, test, expect } from 'bun:test';

import { toSqlWhere, UnsupportedFilterOperatorError } from '../../src/filters/index.js';

describe('toSqlWhere (postgres)', () => {
  test('undefined filter returns empty clause and params', () => {
    const r = toSqlWhere(undefined);
    expect(r.whereClause).toBe('');
    expect(r.params).toEqual([]);
  });

  test('direct equality binds one positional param', () => {
    const r = toSqlWhere({ tenant: 'acme' });
    expect(r.whereClause).toMatch(/metadata->>'tenant' = \$1::text/);
    expect(r.params).toEqual(['acme']);
  });

  test('$eq on field uses parameter binding (no interpolation)', () => {
    const r = toSqlWhere({ tier: { $eq: 'gold' } });
    expect(r.whereClause).toMatch(/\$1::text/);
    expect(r.params).toEqual(['gold']);
  });

  test('$in produces an IN () clause with multiple params', () => {
    const r = toSqlWhere({ status: { $in: ['a', 'b', 'c'] } });
    expect(r.whereClause).toMatch(/IN \(\$1::text, \$2::text, \$3::text\)/);
    expect(r.params).toEqual(['a', 'b', 'c']);
  });

  test('numeric comparators cast to ::numeric', () => {
    const r = toSqlWhere({ score: { $gt: 10 } });
    expect(r.whereClause).toMatch(/\(metadata->>'score'\)::numeric > \$1::numeric/);
    expect(r.params).toEqual([10]);
  });

  test('$and composes clauses with AND', () => {
    const r = toSqlWhere({ $and: [{ a: 'x' }, { b: 'y' }] });
    expect(r.whereClause).toMatch(/AND/);
    expect(r.params).toEqual(['x', 'y']);
  });

  test('$or composes clauses with OR', () => {
    const r = toSqlWhere({ $or: [{ a: 'x' }, { b: 'y' }] });
    expect(r.whereClause).toMatch(/OR/);
  });

  test('$not wraps NOT around inner clause', () => {
    const r = toSqlWhere({ $not: { a: 'x' } });
    expect(r.whereClause).toMatch(/^NOT \(/);
  });

  test('$exists true uses metadata ? operator', () => {
    const r = toSqlWhere({ phone: { $exists: true } });
    expect(r.whereClause).toMatch(/metadata \? 'phone'/);
  });

  test('null value produces IS NULL', () => {
    const r = toSqlWhere({ deleted_at: null });
    expect(r.whereClause).toMatch(/IS NULL/);
  });

  test('unsupported operator throws', () => {
    expect(() => toSqlWhere({ a: { $regex: /foo/ } })).toThrow(UnsupportedFilterOperatorError);
  });

  test('startParamIndex offsets positional params', () => {
    const r = toSqlWhere({ a: 'x' }, 5);
    expect(r.whereClause).toMatch(/\$5::text/);
  });

  test('single-quote in field name is escaped', () => {
    const r = toSqlWhere({ "o'field": 'v' });
    expect(r.whereClause).toMatch(/'o''field'/);
  });
});
