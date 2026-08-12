import { describe, expect, it } from 'bun:test';
import {
  derivePredicateLabel,
  evaluatePredicate,
  predicateSchema,
  type Predicate,
  type PredicateContext,
} from '../../src/flows/definition/index.js';

const ctx: PredicateContext = {
  input: { name: 'Ada', count: 2, flag: false, empty: '', zero: 0, nully: null },
  state: { status: 'open', amount: 10 },
  results: {
    collect: { email: 'a@b.c' },
    empty: null,
    missingish: undefined,
  },
  requestContext: { tenant: 'acme' },
};

describe('evaluatePredicate', () => {
  it('eq / ne compare resolved values with strict equality', () => {
    expect(evaluatePredicate({ op: 'eq', left: { path: 'input.name' }, right: { literal: 'Ada' } }, ctx)).toBe(true);
    expect(evaluatePredicate({ op: 'eq', left: { path: 'input.name' }, right: { literal: 'Bob' } }, ctx)).toBe(false);
    expect(evaluatePredicate({ op: 'ne', left: { path: 'input.flag' }, right: { literal: true } }, ctx)).toBe(true);
    expect(evaluatePredicate({ op: 'eq', left: { path: 'input.zero' }, right: { literal: false } }, ctx)).toBe(false);
    expect(evaluatePredicate({ op: 'eq', left: { literal: null }, right: { literal: null } }, ctx)).toBe(true);
  });

  it('comparison with a missing operand is false, including missing vs missing', () => {
    const missingEq: Predicate = { op: 'eq', left: { path: 'input.absent' }, right: { literal: 'Ada' } };
    const bothMissing: Predicate = { op: 'eq', left: { path: 'input.absent' }, right: { path: 'state.absent' } };
    expect(evaluatePredicate(missingEq, ctx)).toBe(false);
    expect(evaluatePredicate(bothMissing, ctx)).toBe(false);
    expect(evaluatePredicate({ op: 'ne', left: { path: 'input.absent' }, right: { literal: 'Ada' } }, ctx)).toBe(false);
  });

  it('lt / lte / gt / gte compare only number-number or string-string', () => {
    expect(evaluatePredicate({ op: 'lt', left: { path: 'state.amount' }, right: { literal: 20 } }, ctx)).toBe(true);
    expect(evaluatePredicate({ op: 'lte', left: { path: 'state.amount' }, right: { literal: 10 } }, ctx)).toBe(true);
    expect(evaluatePredicate({ op: 'gt', left: { path: 'input.name' }, right: { literal: 'A' } }, ctx)).toBe(true);
    expect(evaluatePredicate({ op: 'gte', left: { path: 'input.name' }, right: { literal: 'Ada' } }, ctx)).toBe(true);
    expect(evaluatePredicate({ op: 'lt', left: { path: 'input.flag' }, right: { literal: true } }, ctx)).toBe(false);
    expect(evaluatePredicate({ op: 'gt', left: { path: 'state.amount' }, right: { literal: '10' } }, ctx)).toBe(false);
    expect(evaluatePredicate({ op: 'lt', left: { path: 'input.absent' }, right: { literal: 1 } }, ctx)).toBe(false);
  });

  it('in / notIn test membership; notIn with a missing value is true', () => {
    expect(evaluatePredicate({ op: 'in', value: { path: 'state.status' }, set: ['open', 'closed'] }, ctx)).toBe(true);
    expect(evaluatePredicate({ op: 'in', value: { path: 'state.status' }, set: ['closed'] }, ctx)).toBe(false);
    expect(evaluatePredicate({ op: 'notIn', value: { path: 'state.status' }, set: ['closed'] }, ctx)).toBe(true);
    expect(evaluatePredicate({ op: 'in', value: { path: 'input.absent' }, set: ['open'] }, ctx)).toBe(false);
    expect(evaluatePredicate({ op: 'notIn', value: { path: 'input.absent' }, set: ['open'] }, ctx)).toBe(true);
  });

  it('exists / notExists distinguish missing from falsy present values', () => {
    expect(evaluatePredicate({ op: 'exists', path: 'input.flag' }, ctx)).toBe(true);
    expect(evaluatePredicate({ op: 'exists', path: 'input.empty' }, ctx)).toBe(true);
    expect(evaluatePredicate({ op: 'exists', path: 'input.zero' }, ctx)).toBe(true);
    expect(evaluatePredicate({ op: 'exists', path: 'input.nully' }, ctx)).toBe(true);
    expect(evaluatePredicate({ op: 'exists', path: 'input.absent' }, ctx)).toBe(false);
    expect(evaluatePredicate({ op: 'notExists', path: 'input.absent' }, ctx)).toBe(true);
    expect(evaluatePredicate({ op: 'notExists', path: 'input.flag' }, ctx)).toBe(false);
  });

  it('null or undefined node results count as missing', () => {
    expect(evaluatePredicate({ op: 'exists', path: 'results.collect' }, ctx)).toBe(true);
    expect(evaluatePredicate({ op: 'exists', path: 'results.collect.email' }, ctx)).toBe(true);
    expect(evaluatePredicate({ op: 'exists', path: 'results.empty' }, ctx)).toBe(false);
    expect(evaluatePredicate({ op: 'exists', path: 'results.missingish' }, ctx)).toBe(false);
    expect(evaluatePredicate({ op: 'exists', path: 'results.nope' }, ctx)).toBe(false);
    expect(evaluatePredicate({ op: 'notExists', path: 'results.empty' }, ctx)).toBe(true);
  });

  it('unknown path root is missing, never a throw', () => {
    expect(() => evaluatePredicate({ op: 'exists', path: 'initData.foo' }, ctx)).not.toThrow();
    expect(evaluatePredicate({ op: 'exists', path: 'initData.foo' }, ctx)).toBe(false);
    expect(evaluatePredicate({ op: 'eq', left: { path: 'nope.x' }, right: { literal: 1 } }, ctx)).toBe(false);
  });

  it('truthy / falsy treat missing as falsy', () => {
    expect(evaluatePredicate({ op: 'truthy', value: { path: 'input.name' } }, ctx)).toBe(true);
    expect(evaluatePredicate({ op: 'truthy', value: { path: 'input.flag' } }, ctx)).toBe(false);
    expect(evaluatePredicate({ op: 'falsy', value: { path: 'input.flag' } }, ctx)).toBe(true);
    expect(evaluatePredicate({ op: 'falsy', value: { path: 'input.zero' } }, ctx)).toBe(true);
    expect(evaluatePredicate({ op: 'truthy', value: { path: 'input.absent' } }, ctx)).toBe(false);
    expect(evaluatePredicate({ op: 'falsy', value: { path: 'input.absent' } }, ctx)).toBe(true);
  });

  it('and / or / not compose without throwing', () => {
    const pred: Predicate = {
      op: 'and',
      args: [
        { op: 'eq', left: { path: 'input.name' }, right: { literal: 'Ada' } },
        {
          op: 'or',
          args: [
            { op: 'gt', left: { path: 'state.amount' }, right: { literal: 5 } },
            { op: 'exists', path: 'input.absent' },
          ],
        },
        { op: 'not', arg: { op: 'exists', path: 'results.empty' } },
      ],
    };
    expect(evaluatePredicate(pred, ctx)).toBe(true);
    expect(evaluatePredicate({ op: 'not', arg: { op: 'exists', path: 'input.name' } }, ctx)).toBe(false);
  });

  it('accepts ${root.path} wrapping used by mapping templates', () => {
    expect(evaluatePredicate({ op: 'eq', left: { path: '${input.name}' }, right: { literal: 'Ada' } }, ctx)).toBe(true);
    expect(evaluatePredicate({ op: 'exists', path: '${requestContext.tenant}' }, ctx)).toBe(true);
  });
});

describe('derivePredicateLabel', () => {
  it('renders a bounded human-readable label with JSON-escaped literals', () => {
    expect(
      derivePredicateLabel({ op: 'eq', left: { path: 'input.name' }, right: { literal: 'Ada' } }),
    ).toBe('input.name == "Ada"');
    expect(derivePredicateLabel({ op: 'exists', path: 'state.status' })).toBe('state.status exists');
    expect(
      derivePredicateLabel({
        op: 'and',
        args: [
          { op: 'or', args: [{ op: 'truthy', value: { path: 'input.flag' } }, { op: 'falsy', value: { literal: 0 } }] },
          { op: 'not', arg: { op: 'in', value: { path: 'state.status' }, set: ['x'] } },
        ],
      }),
    ).toBe('(input.flag is truthy OR 0 is falsy) AND (NOT state.status in ["x"])');
  });

  it('truncates to maxLength with an ellipsis', () => {
    const label = derivePredicateLabel(
      { op: 'eq', left: { path: 'input.name' }, right: { literal: 'Ada' } },
      10,
    );
    expect(label.length).toBe(10);
    expect(label.endsWith('…')).toBe(true);
  });
});

describe('predicateSchema', () => {
  it('accepts every operator shape and rejects unknown ops', () => {
    expect(predicateSchema.safeParse({ op: 'eq', left: { path: 'input.a' }, right: { literal: 1 } }).success).toBe(true);
    expect(predicateSchema.safeParse({ op: 'notIn', value: { path: 'input.a' }, set: [1] }).success).toBe(true);
    expect(predicateSchema.safeParse({ op: 'exists', path: 'state.x' }).success).toBe(true);
    expect(predicateSchema.safeParse({ op: 'not', arg: { op: 'falsy', value: { literal: false } } }).success).toBe(true);
    expect(predicateSchema.safeParse({ op: 'bogus', path: 'input.a' }).success).toBe(false);
  });
});
