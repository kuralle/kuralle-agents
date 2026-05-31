import { describe, test, expect } from 'bun:test';

import { toUpstashFilterString, UnsupportedFilterOperatorError } from '../../src/filters/index.js';

describe('toUpstashFilterString', () => {
  test('undefined filter returns empty string', () => {
    expect(toUpstashFilterString(undefined)).toBe('');
  });

  test('direct equality', () => {
    expect(toUpstashFilterString({ tenant: 'acme' })).toBe(`tenant = 'acme'`);
  });

  test('$and wraps in parens', () => {
    expect(toUpstashFilterString({ $and: [{ a: 'x' }, { b: 'y' }] })).toMatch(/^\(/);
  });

  test('$or composes with OR', () => {
    expect(toUpstashFilterString({ $or: [{ a: 'x' }, { b: 'y' }] })).toMatch(/ OR /);
  });

  test('$in renders IN () list', () => {
    expect(toUpstashFilterString({ status: { $in: ['a', 'b'] } })).toMatch(/IN \('a', 'b'\)/);
  });

  test('$nin throws (not supported)', () => {
    expect(() => toUpstashFilterString({ status: { $nin: ['a'] } })).toThrow(
      UnsupportedFilterOperatorError,
    );
  });

  test('$exists throws', () => {
    expect(() => toUpstashFilterString({ phone: { $exists: true } })).toThrow(
      UnsupportedFilterOperatorError,
    );
  });

  test('null value renders IS NULL', () => {
    expect(toUpstashFilterString({ deleted: null })).toBe('deleted IS NULL');
  });
});
