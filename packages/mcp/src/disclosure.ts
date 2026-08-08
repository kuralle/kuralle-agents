/**
 * MCP tool schema disclosure budget (REQ-16).
 *
 * LiveSkillCatalog solves roster mutation under a frozen prompt — skills added or
 * withdrawn mid-session without rewriting a cached system prompt. MCP tool projection
 * has no roster mutation: the tool map is fixed at connect time and only schema depth
 * varies. Forcing MCP tools through SkillLike would be a type-level lie for no gain.
 */

import { defineTool, type AnyTool } from '@kuralle-agents/core';
import { remoteMcpInputSchema } from './schema.js';
import type { McpOptions } from './types.js';

/**
 * Approximate token count for a serialized tool definition.
 *
 * Deliberately a 4-chars-per-token approximation rather than a real tokenizer:
 * a tokenizer would be a new dependency on the workerd-clean root export, and
 * the threshold this feeds is an order-of-magnitude decision (a 200-tool server
 * is 20x over budget, not 5% over). Documented as approximate on purpose.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** 10% of a 200,000-token context window — Claude Code's threshold. */
export const DEFAULT_DISCLOSURE_BUDGET_TOKENS = 20_000;

/** Name of the retrieval tool registered only when at least one server defers. */
export const MCP_DESCRIBE_TOOL = 'mcp__describe_tool';

const DEFERRED_SCHEMA: Record<string, unknown> = { type: 'object' };

const DEFERRED_DESCRIPTION_SUFFIX =
  ' Full input schema available via mcp__describe_tool.';

export function resolveDisclosureBudget(
  disclosure: McpOptions['disclosure'] | undefined,
): number {
  const budget = disclosure?.budget;
  if (budget === undefined || budget === 'auto') {
    return DEFAULT_DISCLOSURE_BUDGET_TOKENS;
  }
  return budget;
}

type RemoteToolListing = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

/** Serializes what composeMcpSystemPrompt would include for inline projection. */
export function serializeToolDefsForBudget(
  remoteTools: readonly RemoteToolListing[],
): string {
  const parts: string[] = [];
  for (const remoteTool of remoteTools) {
    parts.push(remoteTool.description ?? remoteTool.name);
    const schema =
      remoteTool.inputSchema && typeof remoteTool.inputSchema === 'object'
        ? remoteTool.inputSchema
        : DEFERRED_SCHEMA;
    parts.push(JSON.stringify(schema));
  }
  return parts.join('\n');
}

export function shouldInlineServerSchemas(
  serverName: string,
  remoteTools: readonly RemoteToolListing[],
  budget: number,
  alwaysLoad: readonly string[] | undefined,
): boolean {
  if (alwaysLoad?.includes(serverName)) {
    return true;
  }
  return estimateTokens(serializeToolDefsForBudget(remoteTools)) <= budget;
}

export function deferredInputSchema(): ReturnType<typeof remoteMcpInputSchema> {
  return remoteMcpInputSchema(DEFERRED_SCHEMA);
}

export function deferredToolDescription(serverDescription: string): string {
  return serverDescription + DEFERRED_DESCRIPTION_SUFFIX;
}

export function createDescribeTool(
  schemaByQualifiedName: ReadonlyMap<string, Record<string, unknown>>,
): AnyTool {
  return defineTool({
    name: MCP_DESCRIBE_TOOL,
    description:
      'Fetch the full JSON Schema input for a deferred MCP tool. ' +
      'Call the tool by its own qualified name after inspecting the schema.',
    // Described with the package's own JSON Schema adapter rather than zod: zod is a
    // devDependency here, so importing it from `src/` would leave the published package
    // with an undeclared runtime import on its workerd-clean root export.
    input: remoteMcpInputSchema({
      type: 'object',
      properties: {
        tool: {
          type: 'string',
          description: "Qualified MCP tool name, e.g. 'server__tool'.",
        },
      },
      required: ['tool'],
    }),
    replay: false,
    execute: async (args) => {
      const tool = String((args as { tool?: unknown }).tool ?? '');
      const schema = schemaByQualifiedName.get(tool);
      if (!schema) {
        throw new Error(
          `Unknown MCP tool "${tool}". Use a qualified name like server__tool.`,
        );
      }
      return schema;
    },
  });
}
