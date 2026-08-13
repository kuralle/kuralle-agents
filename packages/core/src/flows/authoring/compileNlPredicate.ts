import { generateObject, type LanguageModel } from 'ai';
import { sha256 } from '../definition/canonical.js';
import { isNlPredicate } from '../definition/authoring.js';
import { predicateSchema, type PathOrLiteral, type Predicate } from '../definition/predicate.js';
import { PREDICATE_PATH_ROOTS } from '../definition/types.js';
import { isCanonicalScopedPath } from '../definition/validate/schema-utils.js';
import type { FlowValidationIssue } from '../definition/validate/types.js';

export const NL_PREDICATE_COMPILER_VERSION = '1';

export const NL_PREDICATE_COMPILER_SYSTEM = [
  'You compile a natural-language flow condition into a Predicate object.',
  'Return only a Predicate: comparison (eq/ne/lt/lte/gt/gte), membership (in/notIn),',
  'existence (exists/notExists), truthiness (truthy/falsy), or boolean composition (and/or/not).',
  'Paths must be dotted identifiers rooted at input, state, results, or requestContext.',
  'Use only paths listed in the user message. Never invent a path.',
  'Prefer the smallest predicate that captures the condition.',
].join(' ');

export interface NlPredicateProvenance {
  modelId: string;
  promptHash: string;
  compilerVersion: string;
}

export interface NlPredicateProvider {
  readonly modelId: string;
  generatePredicate(args: {
    schema: typeof predicateSchema;
    system: string;
    prompt: string;
  }): Promise<unknown>;
}

export type CompileNlPredicateResult =
  | { ok: true; predicate: Predicate; provenance: NlPredicateProvenance }
  | { ok: false; issues: FlowValidationIssue[] };

const ROOTS = new Set<string>(PREDICATE_PATH_ROOTS);

export async function nlPredicatePromptHash(): Promise<string> {
  return sha256(`${NL_PREDICATE_COMPILER_VERSION}\n${NL_PREDICATE_COMPILER_SYSTEM}`);
}

export function isNlPredicateProvider(value: unknown): value is NlPredicateProvider {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { generatePredicate?: unknown }).generatePredicate === 'function' &&
    typeof (value as { modelId?: unknown }).modelId === 'string'
  );
}

function modelIdOf(model: { modelId?: unknown } | unknown): string {
  const id = (model as { modelId?: unknown } | null | undefined)?.modelId;
  return typeof id === 'string' && id.length > 0 ? id : 'unknown';
}

function asProvider(provider: NlPredicateProvider | LanguageModel): NlPredicateProvider {
  if (isNlPredicateProvider(provider)) return provider;
  const model = provider;
  return {
    modelId: modelIdOf(model),
    async generatePredicate({ schema, system, prompt }) {
      const { object } = await generateObject({
        model,
        schema,
        system,
        prompt,
        temperature: 0,
      });
      return object;
    },
  };
}

function unwrapPath(rawPath: string): string {
  const match = /^\$\{([^}]+)\}$/.exec(rawPath.trim());
  return (match ? match[1]! : rawPath).trim();
}

function collectPredicatePaths(pred: Predicate): string[] {
  switch (pred.op) {
    case 'and':
    case 'or':
      return pred.args.flatMap(collectPredicatePaths);
    case 'not':
      return collectPredicatePaths(pred.arg);
    case 'exists':
    case 'notExists':
      return [pred.path];
    case 'truthy':
    case 'falsy':
    case 'in':
    case 'notIn':
      return pathFromRef(pred.value);
    default:
      return [...pathFromRef(pred.left), ...pathFromRef(pred.right)];
  }
}

function pathFromRef(ref: PathOrLiteral): string[] {
  return 'path' in ref ? [ref.path] : [];
}

export function isPathInKnownVariables(path: string, knownVariables: readonly string[]): boolean {
  const raw = unwrapPath(path);
  if (raw === '' || !isCanonicalScopedPath(raw)) return false;
  const root = raw.split('.')[0]!;
  if (!ROOTS.has(root)) return false;
  return knownVariables.some((known) => {
    const allowed = unwrapPath(known);
    return raw === allowed || raw.startsWith(`${allowed}.`) || allowed.startsWith(`${raw}.`);
  });
}

export function scopedPredicateIssues(
  predicate: Predicate,
  knownVariables: readonly string[],
  issuePath: string,
): FlowValidationIssue[] {
  const issues: FlowValidationIssue[] = [];
  for (const path of collectPredicatePaths(predicate)) {
    if (isPathInKnownVariables(path, knownVariables)) continue;
    issues.push({
      code: 'nl-predicate-compile-failed',
      path: issuePath,
      message: `Compiled predicate path "${path}" is not in the known variable scope.`,
    });
  }
  return issues;
}

function fail(path: string, message: string): CompileNlPredicateResult {
  return {
    ok: false,
    issues: [{ code: 'nl-predicate-compile-failed', path, message }],
  };
}

function userPrompt(nl: string, knownVariables: readonly string[]): string {
  const listed =
    knownVariables.length === 0
      ? '(none)'
      : knownVariables.map((name) => `- ${name}`).join('\n');
  return `Legal paths:\n${listed}\n\nCondition:\n${nl}`;
}

export async function compileNlPredicate(
  nl: string,
  knownVariables: readonly string[],
  provider: NlPredicateProvider | LanguageModel,
  issuePath = 'when',
): Promise<CompileNlPredicateResult> {
  const trimmed = nl.trim();
  if (trimmed === '') {
    return fail(issuePath, 'Natural-language condition is empty.');
  }

  const resolved = asProvider(provider);
  const promptHash = await nlPredicatePromptHash();
  const provenance: NlPredicateProvenance = {
    modelId: resolved.modelId,
    promptHash,
    compilerVersion: NL_PREDICATE_COMPILER_VERSION,
  };

  let generated: unknown;
  try {
    generated = await resolved.generatePredicate({
      schema: predicateSchema,
      system: NL_PREDICATE_COMPILER_SYSTEM,
      prompt: userPrompt(trimmed, knownVariables),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(issuePath, `Natural-language condition failed to compile: ${message}`);
  }

  if (isNlPredicate(generated)) {
    return fail(issuePath, 'Compiler returned a natural-language condition instead of a Predicate.');
  }

  const parsed = predicateSchema.safeParse(generated);
  if (!parsed.success) {
    return fail(issuePath, 'Compiler returned an object that is not a valid Predicate.');
  }

  const scopeIssues = scopedPredicateIssues(parsed.data, knownVariables, issuePath);
  if (scopeIssues.length > 0) {
    return { ok: false, issues: scopeIssues };
  }

  return { ok: true, predicate: parsed.data, provenance };
}
