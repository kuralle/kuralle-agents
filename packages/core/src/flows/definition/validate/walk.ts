import type { MappingConfig } from '../mapping.js';
import type { Predicate } from '../predicate.js';
import type { FlowDefinition, FlowNodeDefinition, TransitionRef } from '../types.js';

export function nodePath(index: number): string {
  return `nodes.${index}`;
}

export interface NodeLocation {
  index: number;
  path: string;
  node: FlowNodeDefinition;
}

export interface TransitionVisit {
  path: string;
  nodeId: string;
  nodeIndex: number;
  ref: TransitionRef;
}

export interface PredicateVisit {
  path: string;
  nodeId: string;
  nodeIndex: number;
  predicate: Predicate;
}

export interface TemplateVisit {
  path: string;
  nodeId: string;
  nodeIndex: number;
  template: string;
}

export interface MappingVisit {
  path: string;
  nodeId: string;
  nodeIndex: number;
  config: MappingConfig;
}

export interface ChoiceFlowVisit {
  path: string;
  nodeId: string;
  nodeIndex: number;
  flowId: string;
}

export interface FlowWalk {
  nodes: NodeLocation[];
  byId: Map<string, NodeLocation>;
  transitions: TransitionVisit[];
  predicates: PredicateVisit[];
  templates: TemplateVisit[];
  mappings: MappingVisit[];
  choiceFlows: ChoiceFlowVisit[];
}

function pushTransition(
  visits: TransitionVisit[],
  node: FlowNodeDefinition,
  nodeIndex: number,
  path: string,
  ref: TransitionRef | undefined,
): void {
  if (ref === undefined) return;
  visits.push({ path, nodeId: node.id, nodeIndex, ref });
}

function pushPredicate(
  visits: PredicateVisit[],
  node: FlowNodeDefinition,
  nodeIndex: number,
  path: string,
  predicate: Predicate,
): void {
  visits.push({ path, nodeId: node.id, nodeIndex, predicate });
}

function pushTemplate(
  visits: TemplateVisit[],
  node: FlowNodeDefinition,
  nodeIndex: number,
  path: string,
  template: string | undefined,
): void {
  if (template === undefined) return;
  visits.push({ path, nodeId: node.id, nodeIndex, template });
}

function pushChoiceFlows(
  visits: ChoiceFlowVisit[],
  node: FlowNodeDefinition,
  nodeIndex: number,
  path: string,
  choices: { id: string; flow?: { flowId: string } }[] | undefined,
): void {
  if (!choices) return;
  for (let i = 0; i < choices.length; i++) {
    const flowId = choices[i]?.flow?.flowId;
    if (!flowId) continue;
    visits.push({
      path: `${path}.${i}.flow.flowId`,
      nodeId: node.id,
      nodeIndex,
      flowId,
    });
  }
}

export function walkFlowDefinition(def: FlowDefinition): FlowWalk {
  const nodes: NodeLocation[] = [];
  const byId = new Map<string, NodeLocation>();
  const transitions: TransitionVisit[] = [];
  const predicates: PredicateVisit[] = [];
  const templates: TemplateVisit[] = [];
  const mappings: MappingVisit[] = [];
  const choiceFlows: ChoiceFlowVisit[] = [];

  for (let index = 0; index < def.nodes.length; index++) {
    const node = def.nodes[index]!;
    const path = nodePath(index);
    const location: NodeLocation = { index, path, node };
    nodes.push(location);
    if (node.id && !byId.has(node.id)) byId.set(node.id, location);

    switch (node.kind) {
      case 'reply': {
        pushTemplate(templates, node, index, `${path}.instructions`, node.instructions);
        if ('response' in node) {
          pushTemplate(templates, node, index, `${path}.response.template`, node.response.template);
        }
        pushTransition(transitions, node, index, `${path}.next`, node.next);
        if (node.routes) {
          for (let i = 0; i < node.routes.length; i++) {
            const route = node.routes[i]!;
            pushPredicate(predicates, node, index, `${path}.routes.${i}.when`, route.when);
            pushTransition(transitions, node, index, `${path}.routes.${i}.to`, route.to);
          }
        }
        break;
      }
      case 'collect': {
        pushTemplate(templates, node, index, `${path}.ask`, node.ask);
        pushTemplate(templates, node, index, `${path}.instructions`, node.instructions);
        pushTransition(transitions, node, index, `${path}.next`, node.next);
        pushChoiceFlows(choiceFlows, node, index, `${path}.choices`, node.choices);
        break;
      }
      case 'action': {
        pushTransition(transitions, node, index, `${path}.next`, node.next);
        if (node.routes) {
          for (let i = 0; i < node.routes.length; i++) {
            const route = node.routes[i]!;
            pushPredicate(predicates, node, index, `${path}.routes.${i}.when`, route.when);
            pushTransition(transitions, node, index, `${path}.routes.${i}.to`, route.to);
          }
        }
        if (node.args) {
          mappings.push({ path: `${path}.args`, nodeId: node.id, nodeIndex: index, config: node.args });
          for (const [key, source] of Object.entries(node.args)) {
            if ('template' in source) {
              pushTemplate(templates, node, index, `${path}.args.${key}.template`, source.template);
            }
          }
        }
        break;
      }
      case 'decide': {
        pushTemplate(templates, node, index, `${path}.instructions`, node.instructions);
        if (node.routes) {
          for (let i = 0; i < node.routes.length; i++) {
            const route = node.routes[i]!;
            pushPredicate(predicates, node, index, `${path}.routes.${i}.when`, route.when);
            pushTransition(transitions, node, index, `${path}.routes.${i}.to`, route.to);
          }
        }
        pushTransition(transitions, node, index, `${path}.otherwise`, node.otherwise);
        if (node.confirmGate) {
          pushTransition(transitions, node, index, `${path}.confirmGate.onConfirm`, node.confirmGate.onConfirm);
          pushTransition(transitions, node, index, `${path}.confirmGate.onDecline`, node.confirmGate.onDecline);
          pushTransition(
            transitions,
            node,
            index,
            `${path}.confirmGate.onAmbiguous`,
            node.confirmGate.onAmbiguous,
          );
        }
        pushChoiceFlows(choiceFlows, node, index, `${path}.choices`, node.choices);
        break;
      }
    }
  }

  return { nodes, byId, transitions, predicates, templates, mappings, choiceFlows };
}

export function gotoTarget(ref: TransitionRef): string | undefined {
  return typeof ref === 'object' && 'goto' in ref ? ref.goto : undefined;
}

export function handoffTarget(ref: TransitionRef): string | undefined {
  return typeof ref === 'object' && 'handoff' in ref ? ref.handoff : undefined;
}
