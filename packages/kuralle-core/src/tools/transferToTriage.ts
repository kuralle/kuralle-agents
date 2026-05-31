import { tool } from 'ai';
import { z } from 'zod';
import type { ToolSet } from 'ai';
import type { ToolDeclaration } from '../capabilities/index.js';

const BASE_DESCRIPTION =
  "Call this tool when the user's request is outside your area of expertise or when they explicitly ask to be transferred.";

function buildTransferDescription(specialistScope?: string): string {
  if (!specialistScope?.trim()) {
    return BASE_DESCRIPTION;
  }
  const scope = specialistScope.trim();
  return `Call this tool ONLY when the user's request does NOT match any of these topics: ${scope}. If the request IS about one of these topics, handle it yourself. If the user explicitly asks to be transferred, you may still call this tool.`;
}

export function createTransferToTriageAISDKTool(
  triageAgentId: string,
  specialistScope?: string,
): ToolSet[string] {
  return tool({
    description: buildTransferDescription(specialistScope),
    inputSchema: z.object({
      reason: z.string().describe('Why you are escalating to the routing agent'),
    }),
    execute: async ({ reason }) => ({
      __handoff: true,
      targetAgentId: triageAgentId,
      targetAgent: triageAgentId,
      reason,
    }),
  }) satisfies ToolSet[string];
}

type TransferToTriageArgs = { reason: string };
type TransferToTriageResult = {
  __handoff: true;
  targetAgentId: string;
  targetAgent: string;
  reason: string;
};

export function createTransferToTriageDeclaration(
  triageAgentId: string,
  specialistScope?: string,
): ToolDeclaration<TransferToTriageArgs, TransferToTriageResult> {
  return {
    name: 'transfer_to_triage',
    description: buildTransferDescription(specialistScope),
    parameters: z.object({
      reason: z.string().describe('Why you are escalating to the routing agent'),
    }),
    execute: async (args: TransferToTriageArgs) => ({
      __handoff: true as const,
      targetAgentId: triageAgentId,
      targetAgent: triageAgentId,
      reason: args.reason,
    }),
  };
}

export function shouldInjectTransferToTriage(
  triageAgentId: string | undefined,
  retriagePolicy: 'never' | 'on-handoff-tool' | undefined,
  specialistAgentId: string,
  triageAgentExists: boolean,
  isTriageSpecialist: boolean,
): boolean {
  if (retriagePolicy !== 'on-handoff-tool' || !triageAgentId) {
    return false;
  }
  if (!triageAgentExists || specialistAgentId === triageAgentId || isTriageSpecialist) {
    return false;
  }
  return true;
}
