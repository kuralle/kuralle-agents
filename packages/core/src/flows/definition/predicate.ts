import { z } from 'zod';

const LITERAL_SCALAR = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const pathRef = z.object({ path: z.string().min(1) }).strict();
const literalRef = z.object({ literal: LITERAL_SCALAR }).strict();
const pathOrLiteral = z.union([pathRef, literalRef]);

const COMPARISON_OPS = ['eq', 'ne', 'lt', 'lte', 'gt', 'gte'] as const;
const MEMBERSHIP_OPS = ['in', 'notIn'] as const;

export type PathOrLiteral = { path: string } | { literal: string | number | boolean | null };

export type Predicate =
  | { op: 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte'; left: PathOrLiteral; right: PathOrLiteral }
  | { op: 'in' | 'notIn'; value: PathOrLiteral; set: Array<string | number | boolean | null> }
  | { op: 'exists' | 'notExists'; path: string }
  | { op: 'truthy' | 'falsy'; value: PathOrLiteral }
  | { op: 'and' | 'or'; args: Predicate[] }
  | { op: 'not'; arg: Predicate };

export interface PredicateContext {
  input?: unknown;
  state?: unknown;
  results?: Record<string, unknown>;
  requestContext?: unknown;
}

export const predicateSchema: z.ZodType<Predicate> = z.lazy(() =>
  z.union([
    z.object({ op: z.enum(COMPARISON_OPS), left: pathOrLiteral, right: pathOrLiteral }).strict(),
    z
      .object({
        op: z.enum(MEMBERSHIP_OPS),
        value: pathOrLiteral,
        set: z.array(LITERAL_SCALAR).min(1),
      })
      .strict(),
    z.object({ op: z.enum(['exists', 'notExists']), path: z.string().min(1) }).strict(),
    z.object({ op: z.enum(['truthy', 'falsy']), value: pathOrLiteral }).strict(),
    z.object({ op: z.enum(['and', 'or']), args: z.array(predicateSchema).min(1) }).strict(),
    z.object({ op: z.literal('not'), arg: predicateSchema }).strict(),
  ]),
);

const PATH_PLACEHOLDER = /^\$\{([^}]+)\}$/;
const MISSING = Symbol('predicate.missing');
type Missing = typeof MISSING;

function resolvePath(rawPath: string, ctx: PredicateContext): unknown | Missing {
  const templateMatch = PATH_PLACEHOLDER.exec(rawPath.trim());
  const path = templateMatch ? templateMatch[1]!.trim() : rawPath.trim();
  if (path === '') return MISSING;
  const dot = path.indexOf('.');
  const scope = dot === -1 ? path : path.slice(0, dot);
  const rest = dot === -1 ? '' : path.slice(dot + 1);

  switch (scope) {
    case 'input':
      return walk(ctx.input, rest);
    case 'state':
      return walk(ctx.state, rest);
    case 'requestContext':
      return walk(ctx.requestContext, rest);
    case 'results': {
      if (!rest) return MISSING;
      const innerDot = rest.indexOf('.');
      const nodeId = innerDot === -1 ? rest : rest.slice(0, innerDot);
      const subPath = innerDot === -1 ? '' : rest.slice(innerDot + 1);
      const results = ctx.results;
      if (!results || typeof results !== 'object') return MISSING;
      if (!(nodeId in results)) return MISSING;
      const nodeResult = results[nodeId];
      if (nodeResult === undefined || nodeResult === null) return MISSING;
      return walk(nodeResult, subPath);
    }
    default:
      return MISSING;
  }
}

function walk(root: unknown, path: string): unknown | Missing {
  if (path === '') {
    if (root === undefined || root === null) return MISSING;
    return root;
  }
  const parts = path.split('.');
  let value: unknown = root;
  for (const part of parts) {
    if (value === null || value === undefined) return MISSING;
    if (typeof value !== 'object') return MISSING;
    const record = value as Record<string, unknown>;
    if (!(part in record)) return MISSING;
    value = record[part];
  }
  return value;
}

function resolveValue(ref: PathOrLiteral, ctx: PredicateContext): unknown | Missing {
  if ('literal' in ref) return ref.literal;
  return resolvePath(ref.path, ctx);
}

export function readPredicatePath(path: string, ctx: PredicateContext): unknown | undefined {
  const value = resolvePath(path, ctx);
  return value === MISSING ? undefined : value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function setNested(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.').filter(Boolean);
  if (parts.length === 0) return;
  let cursor: Record<string, unknown> = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]!;
    const next = cursor[key];
    if (!isPlainRecord(next)) {
      cursor[key] = {};
    }
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1]!] = value;
}

/** Build a nested object containing only the listed run-record paths. */
export function pickAllowListedPaths(ctx: PredicateContext, paths: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const raw of paths) {
    const value = resolvePath(raw, ctx);
    if (value === MISSING) continue;
    const templateMatch = PATH_PLACEHOLDER.exec(raw.trim());
    const path = templateMatch ? templateMatch[1]!.trim() : raw.trim();
    if (path === '') continue;
    setNested(out, path, value);
  }
  return out;
}

export function evaluatePredicate(pred: Predicate, ctx: PredicateContext): boolean {
  switch (pred.op) {
    case 'and':
      return Array.isArray(pred.args) && pred.args.every((arg) => evaluatePredicate(arg, ctx));
    case 'or':
      return Array.isArray(pred.args) && pred.args.some((arg) => evaluatePredicate(arg, ctx));
    case 'not':
      return !evaluatePredicate(pred.arg, ctx);
    case 'exists': {
      const v = resolvePath(pred.path, ctx);
      return v !== MISSING;
    }
    case 'notExists': {
      const v = resolvePath(pred.path, ctx);
      return v === MISSING;
    }
    case 'truthy':
    case 'falsy': {
      const v = resolveValue(pred.value, ctx);
      const truthy = v !== MISSING && Boolean(v);
      return pred.op === 'truthy' ? truthy : !truthy;
    }
    case 'in':
    case 'notIn': {
      const v = resolveValue(pred.value, ctx);
      if (v === MISSING) return pred.op === 'notIn';
      const member = pred.set.some((candidate) => candidate === v);
      return pred.op === 'in' ? member : !member;
    }
    case 'eq':
    case 'ne':
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte': {
      const left = resolveValue(pred.left, ctx);
      const right = resolveValue(pred.right, ctx);
      if (left === MISSING || right === MISSING) return false;
      return compare(pred.op, left, right);
    }
    default:
      return false;
  }
}

function compare(op: 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte', left: unknown, right: unknown): boolean {
  if (op === 'eq') return left === right;
  if (op === 'ne') return left !== right;
  if (
    (typeof left === 'number' && typeof right === 'number') ||
    (typeof left === 'string' && typeof right === 'string')
  ) {
    switch (op) {
      case 'lt':
        return left < right;
      case 'lte':
        return left <= right;
      case 'gt':
        return left > right;
      case 'gte':
        return left >= right;
    }
  }
  return false;
}

export function derivePredicateLabel(pred: Predicate, maxLength = 80): string {
  const raw = renderPredicate(pred);
  if (raw.length <= maxLength) return raw;
  return raw.slice(0, maxLength - 1) + '…';
}

function renderPredicate(pred: Predicate): string {
  switch (pred.op) {
    case 'and':
    case 'or':
      return pred.args.map((arg) => wrap(arg, renderPredicate(arg))).join(pred.op === 'and' ? ' AND ' : ' OR ');
    case 'not':
      return `NOT ${wrap(pred.arg, renderPredicate(pred.arg))}`;
    case 'exists':
      return `${pred.path} exists`;
    case 'notExists':
      return `${pred.path} missing`;
    case 'truthy':
      return `${renderValue(pred.value)} is truthy`;
    case 'falsy':
      return `${renderValue(pred.value)} is falsy`;
    case 'in':
      return `${renderValue(pred.value)} in ${JSON.stringify(pred.set)}`;
    case 'notIn':
      return `${renderValue(pred.value)} not in ${JSON.stringify(pred.set)}`;
    case 'eq':
      return `${renderValue(pred.left)} == ${renderValue(pred.right)}`;
    case 'ne':
      return `${renderValue(pred.left)} != ${renderValue(pred.right)}`;
    case 'lt':
      return `${renderValue(pred.left)} < ${renderValue(pred.right)}`;
    case 'lte':
      return `${renderValue(pred.left)} <= ${renderValue(pred.right)}`;
    case 'gt':
      return `${renderValue(pred.left)} > ${renderValue(pred.right)}`;
    case 'gte':
      return `${renderValue(pred.left)} >= ${renderValue(pred.right)}`;
  }
}

function wrap(child: Predicate, rendered: string): string {
  return child.op === 'and' || child.op === 'or' || child.op === 'not' ? `(${rendered})` : rendered;
}

function renderValue(ref: PathOrLiteral): string {
  if ('literal' in ref) return JSON.stringify(ref.literal);
  return ref.path;
}
