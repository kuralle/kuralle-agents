export interface FlowTransitionInlineNode {
  id: string;
}

export interface FlowTransitionSignal {
  __flow_transition: true;
  targetNode: string;
  data?: Record<string, unknown>;
  message?: string;
  /** Optional inline node definition for dynamic transitions (Pipecat-style). */
  node?: FlowTransitionInlineNode;
}

export interface FlowUpdateSignal {
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

/**
 * Speech-friendly continuation marker that replaces a `FlowTransitionSignal`
 * before the result reaches the language model. Internal control fields
 * (`__flow_transition`, `targetNode`, `data`) MUST stay inside the runtime
 * — both the realtime model (Gemini Live, OpenAI Realtime, …) and cascaded
 * text models (Gemini Flash via AI-SDK) go silent post-transition when
 * they receive the raw envelope (GH #28 / GH #29).
 *
 * Shape:
 *   { status: 'transition_complete', to: <targetNode>, message?: <line> }
 *
 * The optional `message` field is the user-supplied speech line from
 * `createFlowTransition(target, data, message)` — when present it tells
 * the model exactly what to say next, mirroring LiveKit's native
 * `llm.handoff({ returns: '...' })` pattern.
 */
export interface FlowTransitionContinuation {
  status: 'transition_complete';
  to: string;
  message?: string;
}

/**
 * Convert a tool-execute result into the value the language model should
 * see. Pass-through for everything that is NOT a flow control signal;
 * replace `FlowTransitionSignal` with a `FlowTransitionContinuation`.
 *
 * Used by the text and voice tool loops so flow control signals share one contract.
 */
export function sanitizeFlowControlSignal(raw: unknown): unknown {
  if (isFlowTransition(raw)) {
    const continuation: FlowTransitionContinuation = {
      status: 'transition_complete',
      to: raw.targetNode,
    };
    if (typeof raw.message === 'string' && raw.message.length > 0) {
      continuation.message = raw.message;
    }
    return continuation;
  }
  return raw;
}
