/** Model-initiated flow-transition tools siloed from flow reply speaking dicts (H1). */
export const FLOW_TRANSITION_CONTROL_TOOL_NAMES = new Set([
  'handoff',
  'transfer_to_agent',
  'final',
  'escalate',
  'recover',
]);

export function isFlowTransitionControlTool(name: string): boolean {
  return FLOW_TRANSITION_CONTROL_TOOL_NAMES.has(name);
}
