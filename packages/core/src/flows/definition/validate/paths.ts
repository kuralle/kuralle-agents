import type { PathOrLiteral, Predicate } from '../predicate.js';
import { PREDICATE_PATH_ROOTS, type JsonSchema } from '../types.js';
import { isCanonicalScopedPath, pathExistence, type PathExistence } from './schema-utils.js';
import type { FlowValidationIssue } from './types.js';
import { PREDICATE_MAX_DEPTH, PREDICATE_MAX_NODES } from './types.js';

const PATH_PLACEHOLDER = /^\$\{([^}]+)\}$/;
const ROOTS = new Set<string>(PREDICATE_PATH_ROOTS);

export interface ScopedPath {
  raw: string;
  root: string;
  rest: string;
}

export interface PathContext {
  input?: JsonSchema;
  state?: JsonSchema;
  results: ReadonlyMap<string, JsonSchema | undefined>;
  requestContext?: JsonSchema;
}

export function unwrapPath(rawPath: string): string {
  const match = PATH_PLACEHOLDER.exec(rawPath.trim());
  return (match ? match[1]! : rawPath).trim();
}

export function parseScopedPath(rawPath: string): ScopedPath | undefined {
  const raw = unwrapPath(rawPath);
  if (raw === '' || !isCanonicalScopedPath(raw)) return undefined;
  const dot = raw.indexOf('.');
  const root = dot === -1 ? raw : raw.slice(0, dot);
  const rest = dot === -1 ? '' : raw.slice(dot + 1);
  return { raw, root, rest };
}

export function measurePredicate(pred: Predicate): { depth: number; nodes: number } {
  switch (pred.op) {
    case 'and':
    case 'or': {
      const kids = pred.args.map(measurePredicate);
      const depth = 1 + Math.max(0, ...kids.map((kid) => kid.depth));
      const nodes = 1 + kids.reduce((sum, kid) => sum + kid.nodes, 0);
      return { depth, nodes };
    }
    case 'not': {
      const inner = measurePredicate(pred.arg);
      return { depth: 1 + inner.depth, nodes: 1 + inner.nodes };
    }
    default:
      return { depth: 1, nodes: 1 };
  }
}

function resultIdAndRest(rest: string): { nodeId: string; subPath: string } | undefined {
  if (!rest) return undefined;
  const dot = rest.indexOf('.');
  return {
    nodeId: dot === -1 ? rest : rest.slice(0, dot),
    subPath: dot === -1 ? '' : rest.slice(dot + 1),
  };
}

export function scopedPathExistence(parsed: ScopedPath, ctx: PathContext): PathExistence {
  switch (parsed.root) {
    case 'input':
      return pathExistence(ctx.input, parsed.rest);
    case 'state':
      return pathExistence(ctx.state, parsed.rest);
    case 'requestContext':
      return pathExistence(ctx.requestContext, parsed.rest);
    case 'results': {
      const split = resultIdAndRest(parsed.rest);
      if (!split) return 'missing';
      if (!ctx.results.has(split.nodeId)) return 'missing';
      return pathExistence(ctx.results.get(split.nodeId), split.subPath);
    }
    default:
      return 'missing';
  }
}

export function validateScopedPath(
  rawPath: string,
  issuePath: string,
  ctx: PathContext,
  code: 'invalid-predicate-reference' | 'invalid-map-reference' | 'invalid-template',
): FlowValidationIssue | undefined {
  const parsed = parseScopedPath(rawPath);
  if (!parsed) {
    return {
      code,
      path: issuePath,
      message: `Path "${rawPath}" must use plain dotted segments rooted at ${PREDICATE_PATH_ROOTS.join(', ')}.`,
    };
  }
  if (!ROOTS.has(parsed.root)) {
    return {
      code,
      path: issuePath,
      message: `Unknown path root "${parsed.root}". Use ${PREDICATE_PATH_ROOTS.join(', ')}.`,
    };
  }
  if (parsed.root === 'results') {
    const split = resultIdAndRest(parsed.rest);
    if (!split) {
      return {
        code,
        path: issuePath,
        message: 'results paths must include a preceding node id.',
      };
    }
    if (!ctx.results.has(split.nodeId)) {
      return {
        code,
        path: issuePath,
        message: `results.${split.nodeId} must reference a preceding node.`,
      };
    }
  }
  if (scopedPathExistence(parsed, ctx) === 'missing') {
    return {
      code,
      path: issuePath,
      message: `Path "${parsed.raw}" does not exist in the known schema.`,
    };
  }
  return undefined;
}

function validateRef(
  ref: PathOrLiteral,
  issuePath: string,
  ctx: PathContext,
): FlowValidationIssue | undefined {
  if ('literal' in ref) return undefined;
  return validateScopedPath(ref.path, `${issuePath}.path`, ctx, 'invalid-predicate-reference');
}

export function validatePredicateTree(
  predicate: Predicate,
  path: string,
  ctx: PathContext,
): FlowValidationIssue[] {
  const issues: FlowValidationIssue[] = [];
  const size = measurePredicate(predicate);
  if (size.depth > PREDICATE_MAX_DEPTH || size.nodes > PREDICATE_MAX_NODES) {
    issues.push({
      code: 'predicate-too-deep',
      path,
      message: `Predicate exceeds bounds (max depth ${PREDICATE_MAX_DEPTH}, max nodes ${PREDICATE_MAX_NODES}).`,
    });
    return issues;
  }

  switch (predicate.op) {
    case 'and':
    case 'or':
      predicate.args.forEach((arg, index) => {
        issues.push(...validatePredicateTree(arg, `${path}.args.${index}`, ctx));
      });
      break;
    case 'not':
      issues.push(...validatePredicateTree(predicate.arg, `${path}.arg`, ctx));
      break;
    case 'exists':
    case 'notExists': {
      const issue = validateScopedPath(predicate.path, `${path}.path`, ctx, 'invalid-predicate-reference');
      if (issue) issues.push(issue);
      break;
    }
    case 'truthy':
    case 'falsy':
    case 'in':
    case 'notIn': {
      const issue = validateRef(predicate.value, `${path}.value`, ctx);
      if (issue) issues.push(issue);
      break;
    }
    default: {
      const left = validateRef(predicate.left, `${path}.left`, ctx);
      const right = validateRef(predicate.right, `${path}.right`, ctx);
      if (left) issues.push(left);
      if (right) issues.push(right);
    }
  }
  return issues;
}
