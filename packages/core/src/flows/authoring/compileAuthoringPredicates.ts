import type { LanguageModel } from 'ai';
import { isNlPredicate, type AuthoringFlowDefinition } from '../definition/authoring.js';
import type { FlowDefinition, JsonSchema, PredicateRoute } from '../definition/types.js';
import { isRecord } from '../definition/validate/schema-utils.js';
import type { FlowValidationIssue } from '../definition/validate/types.js';
import {
  compileNlPredicate,
  type NlPredicateProvider,
  type NlPredicateProvenance,
} from './compileNlPredicate.js';

export interface CompileAuthoringPredicatesResult {
  definition: FlowDefinition;
  compiledCount: number;
  provenance?: NlPredicateProvenance;
  issues: FlowValidationIssue[];
}

function addSchemaPaths(out: Set<string>, prefix: string, schema: JsonSchema | undefined): void {
  const props = schema && isRecord(schema.properties) ? schema.properties : undefined;
  if (!props || Object.keys(props).length === 0) {
    out.add(prefix);
    return;
  }
  for (const [key, child] of Object.entries(props)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    addSchemaPaths(out, `${prefix}.${key}`, isRecord(child) ? (child as JsonSchema) : undefined);
  }
}

export function knownVariablesFromDefinition(def: AuthoringFlowDefinition): string[] {
  const vars = new Set<string>();
  if (def.inputSchema && isRecord(def.inputSchema.properties) && Object.keys(def.inputSchema.properties).length > 0) {
    addSchemaPaths(vars, 'input', def.inputSchema);
  } else {
    vars.add('input');
  }
  for (const node of def.nodes) {
    if (node.kind === 'collect') {
      addSchemaPaths(vars, `results.${node.id}`, node.schema);
    } else if (node.kind === 'action' || node.kind === 'decide') {
      vars.add(`results.${node.id}`);
    }
  }
  return [...vars].sort();
}

export async function compileAuthoringPredicates(
  def: AuthoringFlowDefinition,
  compiler: NlPredicateProvider | LanguageModel | undefined,
): Promise<CompileAuthoringPredicatesResult> {
  const clone = structuredClone(def);
  const knownVariables = knownVariablesFromDefinition(clone);
  const issues: FlowValidationIssue[] = [];
  let compiledCount = 0;
  let provenance: NlPredicateProvenance | undefined;

  for (let nodeIndex = 0; nodeIndex < clone.nodes.length; nodeIndex++) {
    const node = clone.nodes[nodeIndex]!;
    if (node.kind !== 'reply' && node.kind !== 'action' && node.kind !== 'decide') continue;
    if (!node.routes) continue;
    const compiledRoutes: PredicateRoute[] = [];
    for (let routeIndex = 0; routeIndex < node.routes.length; routeIndex++) {
      const route = node.routes[routeIndex]!;
      const issuePath = `nodes.${nodeIndex}.routes.${routeIndex}.when`;
      if (!isNlPredicate(route.when)) {
        compiledRoutes.push({
          when: route.when,
          to: route.to,
          ...(route.whenSource !== undefined ? { whenSource: route.whenSource } : {}),
        });
        continue;
      }
      if (!compiler) {
        issues.push({
          code: 'nl-predicate-compile-failed',
          path: issuePath,
          message: 'Natural-language condition requires a compiler provider at save time.',
        });
        continue;
      }
      const result = await compileNlPredicate(route.when.nl, knownVariables, compiler, issuePath);
      if (!result.ok) {
        issues.push(...result.issues);
        continue;
      }
      compiledCount += 1;
      provenance = result.provenance;
      compiledRoutes.push({
        when: result.predicate,
        to: route.to,
        whenSource: route.when.nl,
      });
    }
    node.routes = compiledRoutes;
  }

  if (issues.length > 0) {
    return { definition: clone as FlowDefinition, compiledCount, provenance, issues };
  }
  return { definition: clone as FlowDefinition, compiledCount, provenance, issues };
}
