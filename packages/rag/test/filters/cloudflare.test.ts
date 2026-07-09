import { describe, test, expect } from 'bun:test';

import { toCloudflareFilter, UnsupportedFilterOperatorError } from '../../src/filters/index.js';

describe('toCloudflareFilter', () => {
  test('undefined filter returns empty object', () => {
    expect(toCloudflareFilter(undefined)).toEqual({});
  });

  test('flat field filters pass through', () => {
    expect(toCloudflareFilter({ tenant: 'acme' })).toEqual({ tenant: 'acme' });
  });

  test('operator-style condition passes through as-is', () => {
    expect(toCloudflareFilter({ score: { $gt: 10 } })).toEqual({ score: { $gt: 10 } });
  });

  test('$and throws (Vectorize only supports flat filters)', () => {
    expect(() => toCloudflareFilter({ $and: [{ a: 'x' }] })).toThrow(
      UnsupportedFilterOperatorError,
    );
  });

  test('$or throws', () => {
    expect(() => toCloudflareFilter({ $or: [{ a: 'x' }] })).toThrow(
      UnsupportedFilterOperatorError,
    );
  });

  test('$not throws', () => {
    expect(() => toCloudflareFilter({ $not: { a: 'x' } })).toThrow(
      UnsupportedFilterOperatorError,
    );
  });
});
