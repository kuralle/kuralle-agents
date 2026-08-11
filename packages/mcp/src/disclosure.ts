// Reimplemented from `vercel/eve`, packages/eve/src/runtime/framework-tools/connection-search-dynamic.ts (Apache-2.0).
// Reimplemented from the described design, not copied; changes were made.

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

const BARE_OBJECT_SCHEMA: Record<string, unknown> = { type: 'object' };

const DEFERRED_DESCRIPTION_SUFFIX =
  ' Full input schema available via mcp__describe_tool.';

export function isDeferredMcpToolDescription(description: string): boolean {
  return description.endsWith(DEFERRED_DESCRIPTION_SUFFIX);
}

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
        : BARE_OBJECT_SCHEMA;
    parts.push(JSON.stringify(schema));
  }
  return parts.join('\n');
}

/**
 * How much of a server's schemas reach the model.
 *
 * `inline` full schemas · `names` parameter names, types and `required`, prose deferred ·
 * `bare` `{ type: 'object' }` only.
 *
 * Not a mode flag: the caller never picks one. It is the same budget applied twice, because
 * two things are true at once. Parameter names are what keep the model calling a deferred
 * tool correctly — without them it malformed 2 calls in 5. But names still scale with tool
 * count, so on a large enough server even names blow the budget. `bare` is the floor of what
 * schema disclosure can shed; `names` is what we use whenever it fits, which is the
 * overwhelmingly common case.
 *
 * What the budget governs is schema bulk, and only that. Below `bare` sits the catalog —
 * every tool's name and description — which no tier drops, because it is what the model
 * routes on. A server broad enough for its catalog alone to exceed the budget is over
 * budget with nothing left to shed, and `catalogTokens` exists to report exactly that.
 * Trimming descriptions would buy the number back by destroying the routing signal, which
 * is the wrong trade at any tool count.
 */
export type DisclosureMode = 'inline' | 'names' | 'bare';

export function resolveDisclosureMode(
  serverName: string,
  remoteTools: readonly RemoteToolListing[],
  budget: number,
  alwaysLoad: readonly string[] | undefined,
): DisclosureMode {
  if (alwaysLoad?.includes(serverName)) {
    return 'inline';
  }
  if (estimateTokens(serializeToolDefsForBudget(remoteTools)) <= budget) {
    return 'inline';
  }
  const withNames = remoteTools
    .map((tool) => JSON.stringify(buildDeferredSchema(tool.inputSchema)))
    .join('\n');
  return estimateTokens(withNames) <= budget ? 'names' : 'bare';
}

/**
 * The irreducible cost of a server: every tool's description plus the bare object schema
 * that replaces its parameters. No disclosure tier goes below this, because the catalog is
 * what the model routes on. Reported when it exceeds the budget so the limit is visible
 * rather than silently unenforceable.
 */
export function catalogTokens(remoteTools: readonly RemoteToolListing[]): number {
  const parts: string[] = [];
  for (const remoteTool of remoteTools) {
    parts.push(deferredToolDescription(remoteTool.description ?? remoteTool.name));
    parts.push(JSON.stringify(BARE_OBJECT_SCHEMA));
  }
  return estimateTokens(parts.join('\n'));
}

function scalarTypeOf(spec: unknown): string {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    return 'string';
  }
  const type = (spec as { type?: unknown }).type;
  if (typeof type === 'string') {
    return type;
  }
  if (Array.isArray(type) && type.length > 0 && typeof type[0] === 'string') {
    return type[0];
  }
  return 'string';
}

/** Strips schema prose while keeping parameter names, scalar types, and `required`. */
export function buildDeferredSchema(
  fullSchema: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (
    !fullSchema ||
    typeof fullSchema !== 'object' ||
    Array.isArray(fullSchema) ||
    fullSchema.type !== 'object' ||
    !fullSchema.properties ||
    typeof fullSchema.properties !== 'object' ||
    Array.isArray(fullSchema.properties)
  ) {
    return BARE_OBJECT_SCHEMA;
  }

  const props: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(fullSchema.properties)) {
    props[name] = { type: scalarTypeOf(spec) };
  }

  const out: Record<string, unknown> = {
    type: 'object',
    properties: props,
  };

  const required = fullSchema.required;
  if (Array.isArray(required) && required.length > 0) {
    out.required = required;
  }

  return out;
}

export function deferredInputSchema(
  fullSchema: Record<string, unknown> | undefined,
): ReturnType<typeof remoteMcpInputSchema> {
  return remoteMcpInputSchema(buildDeferredSchema(fullSchema));
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
