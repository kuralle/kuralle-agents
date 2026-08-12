import type { FlowDefinition } from '../types.js';
import type { FlowValidationIssue } from './types.js';
import { gotoTarget, walkFlowDefinition } from './walk.js';

export function validateFlowStructure(def: FlowDefinition): FlowValidationIssue[] {
  const issues: FlowValidationIssue[] = [];
  const walk = walkFlowDefinition(def);
  const seenIds = new Map<string, number>();

  for (const location of walk.nodes) {
    const id = location.node.id;
    const previous = seenIds.get(id);
    if (previous !== undefined) {
      issues.push({
        code: 'duplicate-node-id',
        path: `${location.path}.id`,
        message: `Node id "${id}" is duplicated.`,
      });
    } else {
      seenIds.set(id, location.index);
    }

    if (location.node.kind === 'reply') {
      const hasResponse = 'response' in location.node;
      const hasGenerate = 'generate' in location.node;
      if (hasResponse === hasGenerate) {
        issues.push({
          code: 'invalid-reply',
          path: location.path,
          message: 'Reply nodes must have exactly one of response.template or generate: true.',
        });
      }
    }
  }

  const startNode = walk.byId.get(def.start);
  if (!startNode) {
    issues.push({
      code: 'missing-start',
      path: 'start',
      message: `Start node "${def.start}" was not found in nodes.`,
    });
  }

  for (const visit of walk.transitions) {
    const target = gotoTarget(visit.ref);
    if (target === undefined) continue;
    if (!walk.byId.has(target)) {
      issues.push({
        code: 'unresolved-transition',
        path: visit.path,
        message: `Transition goto "${target}" does not resolve to a node id.`,
      });
    }
  }

  if (startNode) {
    const reachable = new Set<string>();
    const queue = [startNode.node.id];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (reachable.has(current)) continue;
      reachable.add(current);
      for (const visit of walk.transitions) {
        if (visit.nodeId !== current) continue;
        const target = gotoTarget(visit.ref);
        if (target && walk.byId.has(target) && !reachable.has(target)) queue.push(target);
      }
    }
    for (const location of walk.nodes) {
      if (reachable.has(location.node.id)) continue;
      if (seenIds.get(location.node.id) !== location.index) continue;
      issues.push({
        code: 'unreachable-node',
        path: location.path,
        message: `Node "${location.node.id}" is not reachable from start.`,
      });
    }
  }

  return issues;
}
