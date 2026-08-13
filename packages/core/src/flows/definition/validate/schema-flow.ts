import { TEMPLATE_PATH_ROOTS, validateTemplateSyntax, type MappingConfig } from '../mapping.js';
import type { FlowDefinition, FlowNodeDefinition, JsonSchema } from '../types.js';
import { parseScopedPath, type PathContext, validatePredicateTree, validateScopedPath, unwrapPath } from './paths.js';
import { lookupRegistry } from './refs.js';
import {
  emptyObjectSchema,
  isRecord,
  pathExistence,
  schemaAtPath,
  schemaCompatibility,
  schemaForValue,
  setSchemaPath,
  unionObjectSchemas,
} from './schema-utils.js';
import type { FlowRegistryIndex, FlowValidationIssue } from './types.js';
import { gotoTarget, walkFlowDefinition, type FlowWalk, type NodeLocation } from './walk.js';

export interface GraphSchemaInference {
  nodeOutputs: Map<string, JsonSchema | undefined>;
  nodeState: Map<string, JsonSchema | undefined>;
  issues: FlowValidationIssue[];
}

const PLACEHOLDER = /\$\{([^}]*)\}/g;

function outgoingGotos(walk: FlowWalk, nodeId: string): string[] {
  const targets: string[] = [];
  for (const visit of walk.transitions) {
    if (visit.nodeId !== nodeId) continue;
    const target = gotoTarget(visit.ref);
    if (target) targets.push(target);
  }
  return targets;
}

export function precedingIds(walk: FlowWalk, start: string, target: string): Set<string> {
  const preceding = new Set<string>();
  const visit = (current: string, path: Set<string>): void => {
    if (current === target) {
      for (const id of path) preceding.add(id);
      return;
    }
    if (path.has(current)) return;
    path.add(current);
    for (const next of outgoingGotos(walk, current)) visit(next, path);
    path.delete(current);
  };
  if (walk.byId.has(start)) visit(start, new Set());
  preceding.delete(target);
  return preceding;
}

function bindPath(raw: string): string {
  const path = unwrapPath(raw);
  return path.startsWith('state.') ? path.slice('state.'.length) : path;
}

function producesResult(node: FlowNodeDefinition): boolean {
  return node.kind === 'collect' || node.kind === 'action' || node.kind === 'decide';
}

function pathContext(
  input: JsonSchema | undefined,
  state: JsonSchema | undefined,
  nodeOutputs: ReadonlyMap<string, JsonSchema | undefined>,
  preceding: ReadonlySet<string>,
  selfId: string | undefined,
): PathContext {
  const results = new Map<string, JsonSchema | undefined>();
  for (const id of preceding) {
    if (nodeOutputs.has(id)) results.set(id, nodeOutputs.get(id));
  }
  if (selfId && nodeOutputs.has(selfId)) results.set(selfId, nodeOutputs.get(selfId));
  return { input, state, results };
}

function analyzeMapping(
  config: MappingConfig,
  path: string,
  ctx: PathContext,
): { issues: FlowValidationIssue[]; outputSchema: JsonSchema } {
  const issues: FlowValidationIssue[] = [];
  const properties: Record<string, JsonSchema> = {};
  for (const [key, source] of Object.entries(config)) {
    const fieldPath = `${path}.${key}`;
    if ('value' in source) {
      properties[key] = schemaForValue(source.value);
      continue;
    }
    if ('template' in source) {
      properties[key] = { type: 'string' };
      continue;
    }
    const issue = validateScopedPath(source.path, `${fieldPath}.path`, ctx, 'invalid-map-reference');
    if (issue) issues.push(issue);
    const parsed = parseScopedPath(source.path);
    properties[key] =
      parsed && parsed.root === 'input'
        ? (schemaAtPath(ctx.input, parsed.rest) ?? {})
        : parsed && parsed.root === 'state'
          ? (schemaAtPath(ctx.state, parsed.rest) ?? {})
          : parsed && parsed.root === 'results'
            ? (() => {
                const dot = parsed.rest.indexOf('.');
                const nodeId = dot === -1 ? parsed.rest : parsed.rest.slice(0, dot);
                const sub = dot === -1 ? '' : parsed.rest.slice(dot + 1);
                return schemaAtPath(ctx.results.get(nodeId), sub) ?? {};
              })()
            : {};
  }
  return { issues, outputSchema: { type: 'object', properties, required: Object.keys(config) } };
}

function collectPlaceholders(template: string): string[] {
  const found: string[] = [];
  PLACEHOLDER.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PLACEHOLDER.exec(template)) !== null) {
    const inner = match[1]!.trim();
    if (inner) found.push(inner);
  }
  return found;
}

function extendFromCollect(state: JsonSchema, node: Extract<FlowNodeDefinition, { kind: 'collect' }>): JsonSchema {
  const schema = isRecord(node.schema) ? node.schema : emptyObjectSchema();
  if (!node.assign) {
    const properties = isRecord(schema.properties) ? schema.properties : undefined;
    if (!properties) return unionObjectSchemas(state, { type: 'object' });
    return unionObjectSchemas(state, { type: 'object', properties: properties as Record<string, JsonSchema> });
  }
  let next = state;
  for (const [dest, field] of Object.entries(node.assign)) {
    const fieldSchema = schemaAtPath(schema, field) ?? {};
    next = setSchemaPath(next, bindPath(dest), fieldSchema);
  }
  return next;
}

export function inferGraphSchemas(def: FlowDefinition, index: FlowRegistryIndex): GraphSchemaInference {
  const issues: FlowValidationIssue[] = [];
  const walk = walkFlowDefinition(def);
  const nodeOutputs = new Map<string, JsonSchema | undefined>();
  const nodeState = new Map<string, JsonSchema | undefined>();
  const incomingState = new Map<string, JsonSchema | undefined>();
  const start = walk.byId.get(def.start);
  if (!start) return { nodeOutputs, nodeState, issues };

  const order: NodeLocation[] = [];
  const seen = new Set<string>();
  const queue = [start];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (seen.has(current.node.id)) continue;
    seen.add(current.node.id);
    order.push(current);
    for (const target of outgoingGotos(walk, current.node.id)) {
      const loc = walk.byId.get(target);
      if (loc && !seen.has(loc.node.id)) queue.push(loc);
    }
  }

  incomingState.set(start.node.id, emptyObjectSchema());

  for (const location of order) {
    const ancestors = precedingIds(walk, def.start, location.node.id);
    const stateIn = incomingState.get(location.node.id) ?? emptyObjectSchema();
    nodeState.set(location.node.id, stateIn);
    const argsCtx = pathContext(def.inputSchema, stateIn, nodeOutputs, ancestors, undefined);

    if (location.node.kind === 'action' && location.node.args) {
      const analysis = analyzeMapping(location.node.args, `${location.path}.args`, argsCtx);
      issues.push(...analysis.issues);
      const tool = lookupRegistry(index.tools, location.node.tool);
      if (tool?.inputSchema && schemaCompatibility(analysis.outputSchema, tool.inputSchema) === 'incompatible') {
        issues.push({
          code: 'incompatible-schema',
          path: `${location.path}.args`,
          message: `Action args are incompatible with tool "${location.node.tool}" input schema.`,
        });
      }
    }

    let output: JsonSchema | undefined;
    let stateOut = stateIn;
    switch (location.node.kind) {
      case 'collect': {
        output = isRecord(location.node.schema) ? location.node.schema : undefined;
        stateOut = extendFromCollect(stateIn, location.node);
        if (location.node.assign) {
          const schema = isRecord(location.node.schema) ? location.node.schema : undefined;
          for (const [dest, field] of Object.entries(location.node.assign)) {
            if (pathExistence(schema, field) !== 'missing') continue;
            issues.push({
              code: 'invalid-map-reference',
              path: `${location.path}.assign.${dest}`,
              message: `Assign source "${field}" does not exist in the collect schema.`,
            });
          }
        }
        break;
      }
      case 'action': {
        const tool = lookupRegistry(index.tools, location.node.tool);
        output = tool?.outputSchema;
        if (location.node.bind) {
          const bound = output ?? { type: 'object' };
          stateOut = setSchemaPath(stateIn, bindPath(location.node.bind), bound);
        }
        break;
      }
      case 'decide': {
        output = isRecord(location.node.schema) ? location.node.schema : undefined;
        break;
      }
      case 'reply':
        break;
    }

    if (producesResult(location.node)) nodeOutputs.set(location.node.id, output);

    const routeCtx = pathContext(
      def.inputSchema,
      stateOut,
      nodeOutputs,
      ancestors,
      producesResult(location.node) ? location.node.id : undefined,
    );
    for (const visit of walk.predicates) {
      if (visit.nodeId !== location.node.id) continue;
      issues.push(...validatePredicateTree(visit.predicate, visit.path, routeCtx));
    }
    for (const visit of walk.templates) {
      if (visit.nodeId !== location.node.id) continue;
      const templateCtx = visit.path.includes('.args.') ? argsCtx : routeCtx;
      const syntaxIssues = validateTemplateSyntax(visit.template);
      for (const syntax of syntaxIssues) {
        issues.push({
          code: 'invalid-template',
          path: visit.path,
          message:
            syntax.code === 'mustache_placeholder' ? 'use ${path} placeholders, not {{path}}' : syntax.message,
        });
      }
      if (syntaxIssues.length === 0) {
        for (const inner of collectPlaceholders(visit.template)) {
          const root = inner.split('.')[0] ?? '';
          if (!(TEMPLATE_PATH_ROOTS as readonly string[]).includes(root)) continue;
          const issue = validateScopedPath(inner, visit.path, templateCtx, 'invalid-template');
          if (issue) issues.push(issue);
        }
      }
    }

    for (const target of outgoingGotos(walk, location.node.id)) {
      const existing = incomingState.get(target);
      incomingState.set(target, existing === undefined ? stateOut : unionObjectSchemas(existing, stateOut));
    }
  }

  if (def.outputSchema) {
    for (const visit of walk.transitions) {
      if (gotoTarget(visit.ref)) continue;
      const state = nodeState.get(visit.nodeId);
      const node = walk.byId.get(visit.nodeId)?.node;
      let outgoing = state;
      if (node?.kind === 'collect') outgoing = extendFromCollect(state ?? emptyObjectSchema(), node);
      if (node?.kind === 'action' && node.bind) {
        const tool = lookupRegistry(index.tools, node.tool);
        outgoing = setSchemaPath(state ?? emptyObjectSchema(), bindPath(node.bind), tool?.outputSchema ?? { type: 'object' });
      }
      if (schemaCompatibility(outgoing, def.outputSchema) === 'incompatible') {
        issues.push({
          code: 'incompatible-schema',
          path: 'outputSchema',
          message: 'Flow output schema is incompatible with the state reaching a terminal transition.',
        });
      }
    }
  }

  return { nodeOutputs, nodeState, issues };
}
