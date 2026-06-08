import { z } from 'zod';
import { defineTool } from './effect/defineTool.js';
import type { AnyTool } from '../types/effectTool.js';
import type { Flow } from '../types/flow.js';

/** Result shape emitted by the `enter_flow` control tool. `classifyControl`
 *  recognizes it and turns it into a `TurnControl{ type: 'enterFlow' }`, so the
 *  host loop enters the named flow — routing folded into the speaking turn
 *  instead of a separate upfront `generateObject` selector. */
export interface EnterFlowResult {
  __enterFlow: true;
  flowName: string;
  reason?: string;
}

export function isEnterFlowResult(result: unknown): result is EnterFlowResult {
  return (
    typeof result === 'object' &&
    result !== null &&
    '__enterFlow' in result &&
    (result as { __enterFlow: unknown }).__enterFlow === true &&
    'flowName' in result
  );
}

/** Build the model-visible `enter_flow` control tool from available flows. */
export function createEnterFlowTool(availableFlows: Flow[]): AnyTool {
  const names = availableFlows.map((flow) => flow.name) as [string, ...string[]];
  const lines = availableFlows
    .map((flow) => `- ${flow.name}: ${flow.description}`)
    .join('\n');
  return defineTool({
    name: 'enter_flow',
    description:
      'Start a structured procedure when the user wants to do one of the tasks below. ' +
      'Call this INSTEAD of answering in prose; do not announce the transition to the user.\n\n' +
      `Available procedures:\n${lines}`,
    input: z.object({
      flowName: z.enum(names).describe('Which procedure to start'),
      reason: z.string().describe('Why this procedure, in a few words'),
    }),
    execute: async ({ flowName, reason }): Promise<EnterFlowResult> => ({
      __enterFlow: true,
      flowName,
      reason,
    }),
  });
}
