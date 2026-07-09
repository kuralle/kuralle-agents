import { describe, test, expect } from 'bun:test';

import { toLanceDbWhere, UnsupportedFilterOperatorError } from '../../src/filters/index.js';

describe('toLanceDbWhere', () => {
  test('undefined filter returns null', () => {
    expect(toLanceDbWhere(undefined)).toBeNull();
  });

  test('empty object yields null', () => {
    expect(toLanceDbWhere({})).toBeNull();
  });

  test('direct equality renders string literal', () => {
    expect(toLanceDbWhere({ tenant: 'acme' })).toMatch(
      /json_extract\(metadata, '\$\.tenant'\) = 'acme'/,
    );
  });

  test('numeric $gte renders unquoted number', () => {
    expect(toLanceDbWhere({ score: { $gte: 5 } })).toMatch(/>= 5/);
  });

  test('$in renders comma-separated list', () => {
    expect(toLanceDbWhere({ status: { $in: ['a', 'b'] } })).toMatch(
      /IN \('a', 'b'\)/,
    );
  });

  test('$and composes', () => {
    const r = toLanceDbWhere({ $and: [{ a: 'x' }, { b: 'y' }] });
    expect(r).toMatch(/AND/);
  });

  test('$not wraps NOT', () => {
    expect(toLanceDbWhere({ $not: { a: 'x' } })).toMatch(/^NOT /);
  });

  test('unsupported operator throws', () => {
    expect(() => toLanceDbWhere({ a: { $regex: /foo/ } })).toThrow(
      UnsupportedFilterOperatorError,
    );
  });

  test('string with single quote is escaped via doubling', () => {
    expect(toLanceDbWhere({ name: "O'Brien" })).toMatch(/'O''Brien'/);
  });

  test('boolean renders as TRUE/FALSE', () => {
    expect(toLanceDbWhere({ active: true })).toMatch(/= TRUE/);
    expect(toLanceDbWhere({ active: false })).toMatch(/= FALSE/);
  });

  test('$exists maps to IS NOT NULL / IS NULL', () => {
    expect(toLanceDbWhere({ phone: { $exists: true } })).toMatch(/IS NOT NULL/);
    expect(toLanceDbWhere({ phone: { $exists: false } })).toMatch(/IS NULL/);
  });
});
