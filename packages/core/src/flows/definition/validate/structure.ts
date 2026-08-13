import type { FlowDefinition } from '../types.js';
import type { FlowValidationIssue } from './types.js';
import { gotoTarget, walkFlowDefinition } from './walk.js';

export interface StructureNode {
  id: string;
  path: string;
  index: number;
  kind: string;
  replyMode?: 'response' | 'generate' | 'both' | 'neither';
  opaque?: boolean;
}

export interface StructureTransition {
  path: string;
  nodeId: string;
  goto?: string;
}

export interface StructureGraph {
  start: string;
  nodes: StructureNode[];
  transitions: StructureTransition[];
}

export function validateFlowStructureGraph(graph: StructureGraph): FlowValidationIssue[] {
  const issues: FlowValidationIssue[] = [];
  const seenIds = new Map<string, number>();
  const byId = new Map<string, StructureNode>();

  for (const location of graph.nodes) {
    const id = location.id;
    const previous = seenIds.get(id);
    if (previous !== undefined) {
      issues.push({
        code: 'duplicate-node-id',
        path: `${location.path}.id`,
        message: `Node id "${id}" is duplicated.`,
      });
    } else {
      seenIds.set(id, location.index);
      byId.set(id, location);
    }

    if (location.kind === 'reply' && location.replyMode !== undefined) {
      if (location.replyMode === 'both' || location.replyMode === 'neither') {
        issues.push({
          code: 'invalid-reply',
          path: location.path,
          message: 'Reply nodes must have exactly one of response.template or generate: true.',
        });
      }
    }
  }

  const startNode = byId.get(graph.start);
  if (!startNode) {
    issues.push({
      code: 'missing-start',
      path: 'start',
      message: `Start node "${graph.start}" was not found in nodes.`,
    });
  }

  for (const visit of graph.transitions) {
    if (visit.goto === undefined) continue;
    if (!byId.has(visit.goto)) {
      issues.push({
        code: 'unresolved-transition',
        path: visit.path,
        message: `Transition goto "${visit.goto}" does not resolve to a node id.`,
      });
    }
  }

  if (startNode) {
    const reachable = new Set<string>();
    const queue = [startNode.id];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (reachable.has(current)) continue;
      reachable.add(current);
      const currentNode = byId.get(current);
      if (currentNode?.opaque) {
        for (const location of graph.nodes) {
          if (seenIds.get(location.id) !== location.index) continue;
          if (!reachable.has(location.id)) queue.push(location.id);
        }
        continue;
      }
      for (const visit of graph.transitions) {
        if (visit.nodeId !== current) continue;
        if (visit.goto && byId.has(visit.goto) && !reachable.has(visit.goto)) queue.push(visit.goto);
      }
    }
    for (const location of graph.nodes) {
      if (reachable.has(location.id)) continue;
      if (seenIds.get(location.id) !== location.index) continue;
      issues.push({
        code: 'unreachable-node',
        path: location.path,
        message: `Node "${location.id}" is not reachable from start.`,
      });
    }
  }

  return issues;
}

function replyModeFor(node: FlowDefinition['nodes'][number]): StructureNode['replyMode'] {
  if (node.kind !== 'reply') return undefined;
  const hasResponse = 'response' in node;
  const hasGenerate = 'generate' in node;
  if (hasResponse && hasGenerate) return 'both';
  if (hasResponse) return 'response';
  if (hasGenerate) return 'generate';
  return 'neither';
}

export function validateFlowStructure(def: FlowDefinition): FlowValidationIssue[] {
  const walk = walkFlowDefinition(def);
  return validateFlowStructureGraph({
    start: def.start,
    nodes: walk.nodes.map((location) => ({
      id: location.node.id,
      path: location.path,
      index: location.index,
      kind: location.node.kind,
      replyMode: replyModeFor(location.node),
    })),
    transitions: walk.transitions.map((visit) => ({
      path: visit.path,
      nodeId: visit.nodeId,
      goto: gotoTarget(visit.ref),
    })),
  });
}
