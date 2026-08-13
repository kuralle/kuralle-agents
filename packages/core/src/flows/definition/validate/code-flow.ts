import type { Flow, FlowNode } from '../../../types/flow.js';
import { isFlowNode } from '../../../flow/nodeKinds.js';
import { formatFlowValidationIssues } from './format.js';
import { nodePath } from './walk.js';
import { validateFlowStructureGraph, type StructureGraph, type StructureNode, type StructureTransition } from './structure.js';
import type { FlowValidationIssue } from './types.js';

function resolveStart(flow: Flow): FlowNode {
  return typeof flow.start === 'function' ? flow.start() : flow.start;
}

function isRegistered(node: FlowNode, nodes: FlowNode[]): boolean {
  return nodes.some((candidate) => candidate === node);
}

function readTransition(
  value: unknown,
  nodes: FlowNode[],
  path: string,
  issues: FlowValidationIssue[],
): string | undefined {
  if (value === 'stay') return undefined;
  if (typeof value === 'function') {
    issues.push({
      code: 'inline-transition-target',
      path,
      message: 'Transition thunks are not allowed; return a registered node or { goto: "<id>" }.',
    });
    return undefined;
  }
  if (isFlowNode(value)) {
    if (!isRegistered(value, nodes)) {
      issues.push({
        code: 'inline-transition-target',
        path,
        message: `Node "${value.id}" is not a member of flow.nodes; register it in nodes and reference that object.`,
      });
      return undefined;
    }
    return value.id;
  }
  if (typeof value === 'object' && value !== null) {
    if ('end' in value || 'handoff' in value || 'escalate' in value) return undefined;
    if ('goto' in value) {
      const target = value.goto;
      if (typeof target === 'function') {
        issues.push({
          code: 'inline-transition-target',
          path,
          message: 'Transition thunks are not allowed; return a registered node or { goto: "<id>" }.',
        });
        return undefined;
      }
      if (typeof target === 'string') return target;
      if (isFlowNode(target)) {
        if (!isRegistered(target, nodes)) {
          issues.push({
            code: 'inline-transition-target',
            path,
            message: `Node "${target.id}" is not a member of flow.nodes; register it in nodes and reference that object.`,
          });
          return undefined;
        }
        return target.id;
      }
    }
  }
  return undefined;
}

function pushGoto(
  transitions: StructureTransition[],
  nodeId: string,
  path: string,
  goto: string | undefined,
): void {
  if (goto === undefined) return;
  transitions.push({ path, nodeId, goto });
}

export function projectCodeFlow(flow: Flow): { graph: StructureGraph; issues: FlowValidationIssue[] } {
  const issues: FlowValidationIssue[] = [];
  const nodes: StructureNode[] = [];
  const transitions: StructureTransition[] = [];
  const start = resolveStart(flow);
  if (!isRegistered(start, flow.nodes) && flow.nodes.some((node) => node.id === start.id)) {
    issues.push({
      code: 'missing-start',
      path: 'start',
      message: `Start node "${start.id}" was not found in nodes.`,
    });
  }

  for (let index = 0; index < flow.nodes.length; index++) {
    const node = flow.nodes[index]!;
    const path = nodePath(index);
    let opaque = false;

    switch (node.kind) {
      case 'reply': {
        if (node.next) opaque = true;
        if (node.confidenceGate) {
          pushGoto(
            transitions,
            node.id,
            `${path}.confidenceGate.onLow`,
            readTransition(node.confidenceGate.onLow, flow.nodes, `${path}.confidenceGate.onLow`, issues),
          );
        }
        break;
      }
      case 'collect': {
        opaque = true;
        break;
      }
      case 'action': {
        opaque = true;
        break;
      }
      case 'decide': {
        if (node.decide) opaque = true;
        if (node.confirmGate) {
          pushGoto(
            transitions,
            node.id,
            `${path}.confirmGate.onConfirm`,
            readTransition(node.confirmGate.onConfirm, flow.nodes, `${path}.confirmGate.onConfirm`, issues),
          );
          pushGoto(
            transitions,
            node.id,
            `${path}.confirmGate.onDecline`,
            readTransition(node.confirmGate.onDecline, flow.nodes, `${path}.confirmGate.onDecline`, issues),
          );
          if (node.confirmGate.onAmbiguous !== undefined) {
            pushGoto(
              transitions,
              node.id,
              `${path}.confirmGate.onAmbiguous`,
              readTransition(
                node.confirmGate.onAmbiguous,
                flow.nodes,
                `${path}.confirmGate.onAmbiguous`,
                issues,
              ),
            );
          }
        }
        break;
      }
    }

    nodes.push({
      id: node.id,
      path,
      index,
      kind: node.kind,
      opaque,
    });
  }

  return {
    graph: { start: start.id, nodes, transitions },
    issues,
  };
}

export function assertValidCodeFlow(flow: Flow): void {
  const projected = projectCodeFlow(flow);
  const issues = [...projected.issues, ...validateFlowStructureGraph(projected.graph)];
  if (issues.length === 0) return;
  throw new Error(
    `Flow "${flow.name}" failed validation with ${issues.length} issue(s):\n${formatFlowValidationIssues(issues)}`,
  );
}
