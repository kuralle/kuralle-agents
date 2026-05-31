import { z } from 'zod';
import type { Capability, ToolDeclaration, PromptSection, CapabilityAction } from './index.js';
import type { AgentRoute } from '../types/index.js';
import { isHandoffResult } from '../tools/handoff.js';

// ─── TriageCapability ────────────────────────────────────────────────────────

/**
 * Exposes triage routing as tools: one `route_to_<agentId>` tool per route.
 * The LLM selects the appropriate route; processToolResult converts the
 * tool result to a `handoff` action for the host.
 */
export class TriageCapability implements Capability {
  private routes: AgentRoute[];
  private defaultAgent: string | undefined;

  constructor(routes: AgentRoute[], defaultAgent?: string) {
    this.routes = routes;
    this.defaultAgent = defaultAgent;
  }

  getTools(): ToolDeclaration[] {
    return this.routes.map(route => ({
      name: `route_to_${route.agentId}`,
      description: route.description,
      parameters: z.object({
        reason: z.string().describe('Why this route was chosen — include relevant context from the conversation'),
      }),
      execute: async (args: { reason: string }) => ({
        __handoff: true as const,
        targetAgentId: route.agentId,
        targetAgent: route.agentId,
        reason: args.reason,
      }),
    } as ToolDeclaration));
  }

  getPromptSections(): PromptSection[] {
    if (this.routes.length === 0) return [];

    const routeList = this.routes
      .map(r => `- route_to_${r.agentId}: ${r.description}`)
      .join('\n');

    const defaultNote = this.defaultAgent
      ? `\nIf no route clearly matches, route to ${this.defaultAgent}.`
      : '';

    return [
      {
        role: 'routing',
        content:
          `Route the user to the most appropriate agent using the routing tools below.\n` +
          `Do NOT mention routing or agent transfers to the user.\n\n` +
          `Available routes:\n${routeList}${defaultNote}`,
      },
    ];
  }

  processToolResult(toolName: string, args: unknown, result: unknown): CapabilityAction | null {
    if (!toolName.startsWith('route_to_')) return null;
    if (!isHandoffResult(result)) return null;

    return {
      type: 'handoff',
      targetAgent: result.targetAgentId,
      reason: result.reason,
    };
  }
}
