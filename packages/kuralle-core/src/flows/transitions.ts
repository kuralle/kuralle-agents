interface FlowTransitionInlineNode {
  id: string;
}

interface FlowTransitionSignal {
  __flow_transition: true;
  targetNode: string;
  data?: Record<string, unknown>;
  message?: string;
  /** Optional inline node definition for dynamic transitions (Pipecat-style). */
  node?: FlowTransitionInlineNode;
}

interface FlowUpdateSignal {
  __flow_update: true;
  data?: Record<string, unknown>;
  message?: string;
  missing?: string[];
}

export function createFlowTransition(
  targetNode: string,
  data?: Record<string, unknown>,
  message?: string
): FlowTransitionSignal {
  return {
    __flow_transition: true,
    targetNode,
    data,
    message,
  };
}

export function createFlowTransitionWithNode(
  node: FlowTransitionInlineNode,
  data?: Record<string, unknown>,
  message?: string
): FlowTransitionSignal {
  return {
    __flow_transition: true,
    targetNode: node.id,
    data,
    message,
    node,
  };
}

export function createFlowUpdate(
  data?: Record<string, unknown>,
  message?: string,
  missing?: string[]
): FlowUpdateSignal {
  return {
    __flow_update: true,
    data,
    message,
    missing,
  };
}

export function isFlowTransition(result: unknown): result is FlowTransitionSignal {
  return (
    typeof result === 'object' &&
    result !== null &&
    '__flow_transition' in result &&
    (result as { __flow_transition: unknown }).__flow_transition === true
  );
}

export function isFlowUpdate(result: unknown): result is FlowUpdateSignal {
  return (
    typeof result === 'object' &&
    result !== null &&
    '__flow_update' in result &&
    (result as { __flow_update: unknown }).__flow_update === true
  );
}
