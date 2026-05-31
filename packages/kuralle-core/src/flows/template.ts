import type { FlowPromptContext } from '../types/processors.js';

export type TemplateMissingBehavior = 'keep' | 'empty';

export interface RenderTemplateOptions {
  missing?: TemplateMissingBehavior;
}

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

export function renderNodePrompt(prompt: string | undefined | null, ctx: FlowPromptContext): string {
  return renderFlowTemplate(prompt, ctx.collectedData, { missing: 'keep' });
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

