import { z } from 'zod';
import { renderScopeTemplate, resolveScopePath } from '../template.js';
import type { PredicateContext } from './predicate.js';

export type MappingSource =
  | { value: unknown }
  | { template: string }
  | { path: string };

export type MappingConfig = Record<string, MappingSource>;

export const mappingSourceSchema = z.union([
  z.object({ value: z.unknown() }).strict(),
  z.object({ template: z.string().min(1) }).strict(),
  z.object({ path: z.string().min(1) }).strict(),
]);

export const mappingConfigSchema = z.record(z.string(), mappingSourceSchema);

export const TEMPLATE_PATH_ROOTS = ['input', 'state', 'results', 'requestContext'] as const;

export type TemplateSyntaxIssue = { code: 'mustache_placeholder' | 'empty_placeholder' | 'unknown_root'; message: string };

const PLACEHOLDER = /\$\{([^}]*)\}/g;
const MUSTACHE = /\{\{[^}]*\}\}/;
const KNOWN_ROOTS = new Set<string>(TEMPLATE_PATH_ROOTS);

export function resolveMapping(config: MappingConfig, scope: PredicateContext): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const [key, source] of Object.entries(config)) {
    if ('value' in source) {
      resolved[key] = source.value;
      continue;
    }
    if ('template' in source) {
      resolved[key] = renderScopeTemplate(source.template, scope);
      continue;
    }
    resolved[key] = resolveScopePath(source.path, scope);
  }
  return resolved;
}

export function validateTemplateSyntax(template: string): TemplateSyntaxIssue[] {
  const issues: TemplateSyntaxIssue[] = [];
  if (MUSTACHE.test(template)) {
    issues.push({
      code: 'mustache_placeholder',
      message: 'use ${path} placeholders, not {{path}}',
    });
  }
  PLACEHOLDER.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PLACEHOLDER.exec(template)) !== null) {
    const inner = match[1]!.trim();
    if (inner === '') {
      issues.push({ code: 'empty_placeholder', message: 'empty ${} placeholder' });
      continue;
    }
    const root = inner.split('.')[0]!;
    if (!KNOWN_ROOTS.has(root)) {
      issues.push({ code: 'unknown_root', message: `unknown path root "${root}"` });
    }
  }
  return issues;
}
