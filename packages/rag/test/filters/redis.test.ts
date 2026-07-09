import { describe, test, expect } from 'bun:test';

import { toRedisFilter, UnsupportedFilterOperatorError } from '../../src/filters/index.js';

describe('toRedisFilter', () => {
  test('undefined filter returns wildcard *', () => {
    expect(toRedisFilter(undefined)).toBe('*');
  });

  test('$eq produces @metadata TAG expression', () => {
    expect(toRedisFilter({ tenant: { $eq: 'acme' } })).toMatch(/@metadata:\(/);
  });

  test('direct equality also produces @metadata TAG expression', () => {
    expect(toRedisFilter({ tenant: 'acme' })).toMatch(/@metadata:\(/);
  });

  test('$in uses pipe separator', () => {
    expect(toRedisFilter({ tenant: { $in: ['a', 'b'] } })).toMatch(/a\|b/);
  });

  test('$ne throws (Redis basic filter only supports $eq / $in)', () => {
    expect(() => toRedisFilter({ tenant: { $ne: 'acme' } })).toThrow(
      UnsupportedFilterOperatorError,
    );
  });

  test('$gt throws', () => {
    expect(() => toRedisFilter({ score: { $gt: 5 } })).toThrow(
      UnsupportedFilterOperatorError,
    );
  });

  test('$and joins with spaces', () => {
    const r = toRedisFilter({ $and: [{ a: { $eq: 'x' } }, { b: { $eq: 'y' } }] });
    expect(r.split(' ').length).toBeGreaterThan(1);
  });

  test('$or uses | separator inside parens', () => {
    const r = toRedisFilter({ $or: [{ a: { $eq: 'x' } }, { b: { $eq: 'y' } }] });
    expect(r).toMatch(/\(.* \| .*\)/);
  });

  test('$not prefixes with -', () => {
    expect(toRedisFilter({ $not: { a: { $eq: 'x' } } })).toMatch(/^-/);
  });
});
