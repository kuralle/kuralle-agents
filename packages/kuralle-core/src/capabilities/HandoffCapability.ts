import { z } from 'zod';
import type { Capability, ToolDeclaration, PromptSection, CapabilityAction } from './index.js';
import { isHandoffResult } from '../tools/handoff.js';

// ─── Config ──────────────────────────────────────────────────────────────────

export interface HandoffTarget {
  id: string;
  name: string;
  description?: string;
}

// ─── HandoffCapability ───────────────────────────────────────────────────────

/**
 * Exposes a single `transfer_to_agent` tool for agents that have explicit
 * `canHandoffTo` targets. Unlike TriageCapability (one tool per route),
 * this uses a single tool with an enum parameter for the target agent.
 */
export class HandoffCapability implements Capability {
  private targets: HandoffTarget[];

  constructor(targets: HandoffTarget[]) {
    this.targets = targets;
  }

  getTools(): ToolDeclaration[] {
    if (this.targets.length === 0) return [];

    const agentIds = this.targets.map(t => t.id) as [string, ...string[]];

    const agentDescriptions = this.targets
      .map(t => `- ${t.id} (${t.name})${t.description ? `: ${t.description}` : ''}`)
      .join('\n');

    return [
      {
        name: 'transfer_to_agent',
        description:
          `Transfer the conversation to a specialized agent.\n` +
          `Do NOT mention this transfer to the user.\n\n` +
          `Available agents:\n${agentDescriptions}`,
        parameters: z.object({
          targetAgentId: z.enum(agentIds).describe('The ID of the agent to transfer to'),
          reason: z.string().describe('Why you are transferring — include relevant context'),
          summary: z.string().optional().describe('Optional summary of what has been done so far'),
        }),
        execute: async (args: { targetAgentId: string; reason: string; summary?: string }) => ({
          __handoff: true as const,
          targetAgentId: args.targetAgentId,
          targetAgent: args.targetAgentId,
          reason: args.reason,
          summary: args.summary,
        }),
      } as ToolDeclaration,
    ];
  }

  getPromptSections(): PromptSection[] {
    return [];
  }

  processToolResult(toolName: string, args: unknown, result: unknown): CapabilityAction | null {
    if (toolName === 'transfer_to_triage') {
      if (!isHandoffResult(result)) return null;
      const target = result.targetAgentId ?? result.targetAgent;
      if (!target) return null;
      return {
        type: 'handoff',
        targetAgent: target,
        reason: result.reason,
      };
    }

    // Match both 'transfer_to_agent' (capability name) and 'handoff' (legacy flow injection key)
    if (toolName !== 'transfer_to_agent' && toolName !== 'handoff') return null;
    if (!isHandoffResult(result)) return null;

    return {
      type: 'handoff',
      targetAgent: result.targetAgentId,
      reason: result.reason,
    };
  }
}
