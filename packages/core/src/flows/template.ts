import type { PredicateContext } from './definition/predicate.js';

type TemplateMissingBehavior = 'keep' | 'empty';

export interface RenderTemplateOptions {
  missing?: TemplateMissingBehavior;
}

const DOLLAR_PLACEHOLDER = /\$\{([^}]*)\}/g;
const SCOPE_ROOTS = new Set(['input', 'state', 'results', 'requestContext']);
const MISSING = Symbol('template.missing');

function getPath(obj: unknown, path: string): unknown {
  if (!path) return undefined;
  const parts = path.split('.').filter(Boolean);
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function walk(root: unknown, path: string): unknown | typeof MISSING {
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

export function resolveScopePath(rawPath: string, scope: PredicateContext): unknown {
  const path = rawPath.trim();
  if (path === '') return undefined;
  const dot = path.indexOf('.');
  const root = dot === -1 ? path : path.slice(0, dot);
  const rest = dot === -1 ? '' : path.slice(dot + 1);
  switch (root) {
    case 'input':
      return missingToUndefined(walk(scope.input, rest));
    case 'state':
      return missingToUndefined(walk(scope.state, rest));
    case 'requestContext':
      return missingToUndefined(walk(scope.requestContext, rest));
    case 'results': {
      if (!rest) return undefined;
      const innerDot = rest.indexOf('.');
      const nodeId = innerDot === -1 ? rest : rest.slice(0, innerDot);
      const subPath = innerDot === -1 ? '' : rest.slice(innerDot + 1);
      const results = scope.results;
      if (!results || typeof results !== 'object') return undefined;
      if (!(nodeId in results)) return undefined;
      return missingToUndefined(walk(results[nodeId], subPath));
    }
    default:
      return undefined;
  }
}

function missingToUndefined(value: unknown | typeof MISSING): unknown {
  return value === MISSING ? undefined : value;
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function formatScopeValue(v: unknown, placeholder: string): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  try {
    return JSON.stringify(v);
  } catch (error) {
    if (isCircularError(error)) {
      throw new Error(`Circular value at placeholder \${${placeholder}}`);
    }
    throw error;
  }
}

function isCircularError(error: unknown): boolean {
  if (!(error instanceof TypeError)) return false;
  return /circular|cyclic/i.test(error.message);
}

/**
 * Very small mustache-like renderer for flow prompts.
 * Supports: {{key}} and {{nested.key}} from collectedData.
 */
export function renderFlowTemplate(
  text: string | undefined | null,
  data: Record<string, unknown>,
  options: RenderTemplateOptions = {}
): string {
  // Guard against non-string input
  if (text === undefined || text === null) {
    return '';
  }
  if (typeof text !== 'string') {
    // If it's an object, try to stringify it
    try {
      return JSON.stringify(text);
    } catch {
      return String(text);
    }
  }

  const missingBehavior: TemplateMissingBehavior = options.missing ?? 'keep';
  return text.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_m, key: string) => {
    const v = getPath(data, key);
    if (v === undefined) {
      return missingBehavior === 'empty' ? '' : `{{${key}}}`;
    }
    return formatValue(v);
  });
}

/**
 * Sync `${path}` renderer over `input | state | results.<nodeId> | requestContext`.
 * Primitives via String, objects/arrays via JSON.stringify, null/undefined → empty string.
 */
export function renderScopeTemplate(template: string, scope: PredicateContext): string {
  DOLLAR_PLACEHOLDER.lastIndex = 0;
  return template.replace(DOLLAR_PLACEHOLDER, (_match, raw: string) => {
    const inner = raw.trim();
    if (inner === '') return '';
    const root = inner.split('.')[0] ?? '';
    if (!SCOPE_ROOTS.has(root)) {
      throw new Error(`Unknown path root "${root}" in placeholder \${${inner}}`);
    }
    return formatScopeValue(resolveScopePath(inner, scope), inner);
  });
}

function parseRegexLiteral(pattern: string): RegExp | null {
  // Support "/foo/i" style literals from JSON config.
  if (!pattern.startsWith('/') || pattern.lastIndexOf('/') === 0) return null;
  const lastSlash = pattern.lastIndexOf('/');
  const body = pattern.slice(1, lastSlash);
  const flags = pattern.slice(lastSlash + 1);
  try {
    return new RegExp(body, flags);
  } catch {
    return null;
  }
}

export function compileSanitizePattern(pattern: string): RegExp {
  const literal = parseRegexLiteral(pattern);
  if (literal) return literal;
  return new RegExp(pattern, 'i');
}
