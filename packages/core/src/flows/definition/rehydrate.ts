import { z } from 'zod';
import type { AnyTool } from '../../types/effectTool.js';
import type {
  ActionNode,
  CollectNode,
  DecideNode,
  Flow,
  FlowNode,
  FlowState,
  ReplyNode,
  Transition,
} from '../../types/flow.js';
import type { TurnResult } from '../../types/channel.js';
import type { StandardSchemaV1 } from '../../types/standard-schema.js';
import { renderScopeTemplate } from '../template.js';
import { resolveMapping } from './mapping.js';
import { evaluatePredicate } from './predicate.js';
import type { PredicateContext } from './predicate.js';
import { adaptJsonSchema, jsonSchemaRequiredFields, type UnsupportedSchemaMode } from './jsonSchemaAdapter.js';
import { stashFlowDefinition } from './storable.js';
import { segmentsForLiveFlow } from './segments.js';
import type {
  ActionNodeDefinition,
  CollectNodeDefinition,
  DecideNodeDefinition,
  FlowDefinition,
  FlowNodeDefinition,
  ReplyNodeDefinition,
  TransitionRef,
} from './types.js';
import { assertValidFlowDefinition, validateFlowDefinition } from './validate/index.js';
import type { FlowRegistryIndex } from './validate/types.js';

export const FLOW_INPUT_KEY = '__input';
export const FLOW_RESULTS_KEY = '__results';

export interface FlowRehydrationDeps {
  tools: (id: string) => AnyTool | undefined;
  mode?: 'strict' | 'lenient';
  onUnsupportedSchema?: UnsupportedSchemaMode;
  requestContext?: () => unknown;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneDefinition(def: FlowDefinition): FlowDefinition {
  return structuredClone(def);
}

function setStatePath(state: FlowState, dest: string, value: unknown): void {
  const path = dest.startsWith('state.') ? dest.slice('state.'.length) : dest;
  const parts = path.split('.').filter(Boolean);
  if (parts.length === 0) return;
  let cursor: Record<string, unknown> = state;
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

function readField(data: unknown, field: string): unknown {
  if (!field) return data;
  const parts = field.split('.').filter(Boolean);
  let cursor: unknown = data;
  for (const part of parts) {
    if (!isPlainRecord(cursor) || !(part in cursor)) return undefined;
    cursor = cursor[part];
  }
  return cursor;
}

export function recordNodeResult(state: FlowState, nodeId: string, value: unknown): void {
  const existing = state[FLOW_RESULTS_KEY];
  const results = isPlainRecord(existing) ? existing : {};
  if (existing !== results) {
    state[FLOW_RESULTS_KEY] = results;
  }
  results[nodeId] = value;
}

export function scopeFromState(state: FlowState, deps: FlowRehydrationDeps): PredicateContext {
  const results = state[FLOW_RESULTS_KEY];
  return {
    input: state[FLOW_INPUT_KEY],
    state,
    results: isPlainRecord(results) ? results : {},
    requestContext: deps.requestContext?.(),
  };
}

function resolveTransitionRef(ref: TransitionRef | undefined, byId: Map<string, FlowNode>): Transition {
  if (ref === undefined || ref === 'stay') return 'stay';
  if ('goto' in ref) {
    const node = byId.get(ref.goto);
    if (!node) {
      throw new Error(`Unresolved goto "${ref.goto}"`);
    }
    return ref.data !== undefined ? { goto: ref.goto, data: ref.data } : node;
  }
  if ('handoff' in ref) {
    return { handoff: ref.handoff, reason: ref.reason };
  }
  if ('escalate' in ref) {
    return { escalate: ref.escalate };
  }
  return { end: ref.end };
}

function firstMatchingRoute(
  routes: { when: Parameters<typeof evaluatePredicate>[0]; to: TransitionRef }[] | undefined,
  scope: PredicateContext,
  byId: Map<string, FlowNode>,
): Transition | undefined {
  if (!routes) return undefined;
  for (const route of routes) {
    if (evaluatePredicate(route.when, scope)) {
      return resolveTransitionRef(route.to, byId);
    }
  }
  return undefined;
}

function requireTool(deps: FlowRehydrationDeps, toolId: string): AnyTool {
  const tool = deps.tools(toolId);
  if (!tool) {
    throw new Error(`Unknown tool "${toolId}" is not in rehydration deps`);
  }
  return tool;
}

function rehydrateReply(
  def: ReplyNodeDefinition,
  byId: Map<string, FlowNode>,
  deps: FlowRehydrationDeps,
): ReplyNode {
  const instructions = def.instructions
    ? ({ state }: { state: FlowState }) => renderScopeTemplate(def.instructions!, scopeFromState(state, deps))
    : '';
  const next =
    def.next !== undefined || (def.routes?.length ?? 0) > 0
      ? (_turn: TurnResult, state: FlowState) =>
          firstMatchingRoute(def.routes, scopeFromState(state, deps), byId) ??
          resolveTransitionRef(def.next, byId)
      : undefined;
  if ('response' in def) {
    return {
      kind: 'reply',
      id: def.id,
      instructions,
      response: (state) => {
        const text = renderScopeTemplate(def.response.template, scopeFromState(state, deps));
        recordNodeResult(state, def.id, text);
        return text;
      },
      ...(next ? { next } : {}),
    };
  }
  return {
    kind: 'reply',
    id: def.id,
    instructions,
    ...(next ? { next } : {}),
  };
}

function rehydrateCollect(
  def: CollectNodeDefinition,
  byId: Map<string, FlowNode>,
  deps: FlowRehydrationDeps,
  onUnsupportedSchema: UnsupportedSchemaMode,
): CollectNode {
  const schema = adaptJsonSchema(def.schema, `nodes.${def.id}.schema`, onUnsupportedSchema);
  const required = def.required ?? jsonSchemaRequiredFields(def.schema);
  return {
    kind: 'collect',
    id: def.id,
    schema,
    ...(required ? { required } : {}),
    ...(def.maxTurns !== undefined ? { maxTurns: def.maxTurns } : {}),
    ...(def.choices ? { choices: def.choices } : {}),
    ...(def.ask !== undefined
      ? {
          ask: (_missing: string[], state: FlowState) =>
            renderScopeTemplate(def.ask!, scopeFromState(state, deps)),
        }
      : {}),
    ...(def.instructions !== undefined
      ? {
          instructions: (_missing: string[], state: FlowState) =>
            renderScopeTemplate(def.instructions!, scopeFromState(state, deps)),
        }
      : {}),
    onComplete: (data, state) => {
      recordNodeResult(state, def.id, data);
      if (def.assign) {
        for (const [dest, field] of Object.entries(def.assign)) {
          setStatePath(state, dest, readField(data, field));
        }
      } else if (isPlainRecord(data)) {
        Object.assign(state, data);
      }
      return resolveTransitionRef(def.next, byId);
    },
  };
}

function rehydrateAction(
  def: ActionNodeDefinition,
  byId: Map<string, FlowNode>,
  deps: FlowRehydrationDeps,
): ActionNode {
  requireTool(deps, def.tool);
  return {
    kind: 'action',
    id: def.id,
    run: async (state, ctx) => {
      const tool = requireTool(deps, def.tool);
      const scope = scopeFromState(state, deps);
      const args = def.args ? resolveMapping(def.args, scope) : {};
      const result = await ctx.tool(def.tool, args, {
        def: def.approval ? { ...tool, needsApproval: true } : tool,
      });
      recordNodeResult(state, def.id, result);
      if (def.bind) {
        setStatePath(state, def.bind, result);
      }
      return (
        firstMatchingRoute(def.routes, scopeFromState(state, deps), byId) ??
        resolveTransitionRef(def.next, byId)
      );
    },
  };
}

function rehydrateDecide(
  def: DecideNodeDefinition,
  byId: Map<string, FlowNode>,
  deps: FlowRehydrationDeps,
  onUnsupportedSchema: UnsupportedSchemaMode,
): DecideNode {
  const schema: StandardSchemaV1 | undefined = def.schema
    ? adaptJsonSchema(def.schema, `nodes.${def.id}.schema`, onUnsupportedSchema)
    : def.confirmGate
      ? undefined
      : z.object({});
  // runFlow requires schema+decide unless confirmGate is set; this empty object is not a dialect field.
  const decideFn =
    def.confirmGate && !def.routes && !def.otherwise
      ? undefined
      : (data: unknown, state: FlowState) => {
          recordNodeResult(state, def.id, data);
          return (
            firstMatchingRoute(def.routes, scopeFromState(state, deps), byId) ??
            resolveTransitionRef(def.otherwise, byId)
          );
        };
  return {
    kind: 'decide',
    id: def.id,
    instructions: def.instructions
      ? ({ state }: { state: FlowState }) =>
          renderScopeTemplate(def.instructions!, scopeFromState(state, deps))
      : '',
    ...(schema ? { schema } : {}),
    ...(def.choices ? { choices: def.choices } : {}),
    ...(def.confirmGate
      ? {
          confirmGate: {
            onConfirm: resolveTransitionRef(def.confirmGate.onConfirm, byId),
            onDecline: resolveTransitionRef(def.confirmGate.onDecline, byId),
            ...(def.confirmGate.onAmbiguous
              ? { onAmbiguous: resolveTransitionRef(def.confirmGate.onAmbiguous, byId) }
              : {}),
          },
        }
      : {}),
    ...(decideFn ? { decide: decideFn } : {}),
  };
}

function rehydrateNode(
  def: FlowNodeDefinition,
  byId: Map<string, FlowNode>,
  deps: FlowRehydrationDeps,
  onUnsupportedSchema: UnsupportedSchemaMode,
): FlowNode {
  switch (def.kind) {
    case 'reply':
      return rehydrateReply(def, byId, deps);
    case 'collect':
      return rehydrateCollect(def, byId, deps, onUnsupportedSchema);
    case 'action':
      return rehydrateAction(def, byId, deps);
    case 'decide':
      return rehydrateDecide(def, byId, deps, onUnsupportedSchema);
  }
}

function toolsIndexFromDeps(def: FlowDefinition, deps: FlowRehydrationDeps): FlowRegistryIndex {
  const tools: NonNullable<FlowRegistryIndex['tools']> = {};
  for (const node of def.nodes) {
    if (node.kind !== 'action') continue;
    const tool = requireTool(deps, node.tool);
    tools[node.tool] = { id: tool.name ?? node.tool };
  }
  return { tools };
}

export function rehydrateFlow(def: FlowDefinition, deps: FlowRehydrationDeps): Flow {
  const onUnsupportedSchema = deps.onUnsupportedSchema ?? (deps.mode === 'lenient' ? 'warn' : 'throw');
  const index = toolsIndexFromDeps(def, deps);
  if (deps.mode === 'lenient') {
    validateFlowDefinition(def, index);
  } else {
    assertValidFlowDefinition(def, index);
  }

  const byId = new Map<string, FlowNode>();
  const nodes = def.nodes.map((nodeDef) => {
    const node = rehydrateNode(nodeDef, byId, deps, onUnsupportedSchema);
    byId.set(node.id, node);
    return node;
  });

  const start = byId.get(def.start);
  if (!start) {
    throw new Error(`Start node "${def.start}" was not found in nodes`);
  }

  const flow: Flow = {
    name: def.name,
    description: def.description,
    start,
    nodes,
    origin: 'definition',
    state: {
      input: (source) => ({
        ...source,
        [FLOW_INPUT_KEY]: source,
        [FLOW_RESULTS_KEY]: {},
      }),
    },
  };
  stashFlowDefinition(flow, cloneDefinition(def));
  segmentsForLiveFlow(flow);
  return flow;
}
