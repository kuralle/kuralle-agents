import type { ActionNode, CollectNode, DecideNode, Flow, FlowNode, ReplyNode } from '../../types/flow.js';
import { readStashedFlowDefinition } from './storable.js';
import type { FlowDefinition } from './types.js';

function throwClosure(nodeId: string, field: string, replacement: string): never {
  throw new Error(
    `${field} on node "${nodeId}" is a code closure; use ${replacement} on a FlowDefinition (or serialize a flow produced by rehydrateFlow).`,
  );
}

function assertStorableReply(node: ReplyNode): void {
  if (typeof node.instructions === 'function') {
    throwClosure(node.id, 'instructions', 'a string (templates via ${path})');
  }
  if (node.response) {
    throwClosure(node.id, 'response', 'response: { template: "..." }');
  }
  if (typeof node.tools === 'function') {
    throwClosure(node.id, 'tools', 'agent-level tools referenced by id, not a node tools function');
  }
  if (node.next) {
    throwClosure(node.id, 'next', 'next: { goto: "<nodeId>" } | { end } | { escalate } | { handoff } | "stay"');
  }
  if (typeof node.grounding?.query === 'function') {
    throwClosure(node.id, 'grounding.query', 'a string query; function grounding is code-only');
  }
  if (node.verify) {
    throwClosure(node.id, 'verify', 'declarative outputSchema on the definition (code verify is not storable)');
  }
}

function assertStorableCollect(node: CollectNode): void {
  throwClosure(node.id, 'onComplete', 'next + assign');
}

function assertStorableAction(node: ActionNode): void {
  throwClosure(node.id, 'run', 'tool, args, bind, next / routes');
}

function assertStorableDecide(node: DecideNode): void {
  if (node.decide) {
    throwClosure(node.id, 'decide', 'routes + otherwise');
  }
  if (typeof node.instructions === 'function') {
    throwClosure(node.id, 'instructions', 'a string (templates via ${path})');
  }
  if (node.confirmGate) {
    throw new Error(
      `confirmGate on node "${node.id}" holds inline Transition nodes; use confirmGate: { onConfirm, onDecline } TransitionRefs.`,
    );
  }
}

function assertStorableNode(node: FlowNode): void {
  switch (node.kind) {
    case 'reply':
      assertStorableReply(node);
      return;
    case 'collect':
      assertStorableCollect(node);
      return;
    case 'action':
      assertStorableAction(node);
      return;
    case 'decide':
      assertStorableDecide(node);
  }
}

export function toStorableFlow(flow: Flow): FlowDefinition {
  const stashed = readStashedFlowDefinition(flow);
  if (flow.origin === 'definition' && stashed) {
    return structuredClone(stashed);
  }

  if (typeof flow.start === 'function') {
    throw new Error('Flow.start is a thunk; use start: "<nodeId>" in the FlowDefinition.');
  }

  for (const node of flow.nodes) {
    assertStorableNode(node);
  }

  throw new Error(
    `Code-authored flow "${flow.name}" cannot be serialized; every closure field needs a declarative replacement, or pass a flow produced by rehydrateFlow.`,
  );
}
