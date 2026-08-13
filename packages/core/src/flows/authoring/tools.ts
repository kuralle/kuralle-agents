import { z } from 'zod';
import { defineTool } from '../../tools/effect/defineTool.js';
import type { AnyTool } from '../../types/effectTool.js';
import { flowDefinitionSchema, type FlowDefinition } from '../definition/index.js';
import { formatFlowValidationIssues } from '../definition/validate/format.js';
import { validateFlowDefinition } from '../definition/validate/index.js';
import type { FlowValidationIssue } from '../definition/validate/types.js';
import {
  normalizeFlowBuilderCatalog,
  registryIndexFromCatalogs,
  type FlowBuilderCatalogEntry,
} from './catalog.js';
import { FLOW_BUILDER_TOOL_NAMES } from './playbook.js';
import type { FlowBuilderHost } from './types.js';

export type SaveFlowSuccess = { ok: true; names: string[] };

export type SaveFlowFailure = {
  ok: false;
  error: true;
  message: string;
  issues?: FlowValidationIssue[];
  details?: unknown;
};

export type SaveFlowResult = SaveFlowSuccess | SaveFlowFailure;

const saveFlowInputSchema = z
  .object({
    definition: z.unknown(),
    replace: z.boolean().optional(),
    dependencies: z.array(z.unknown()).optional(),
  })
  .strict();

function catalogsOf(host: FlowBuilderHost): {
  tools: FlowBuilderCatalogEntry[];
  flows: FlowBuilderCatalogEntry[];
  agents: FlowBuilderCatalogEntry[];
} {
  return {
    tools: normalizeFlowBuilderCatalog(host.tools()),
    flows: normalizeFlowBuilderCatalog(host.flows?.()),
    agents: normalizeFlowBuilderCatalog(host.agents?.()),
  };
}

function parseDefinition(
  raw: unknown,
  path: string,
): { ok: true; def: FlowDefinition } | { ok: false; result: SaveFlowFailure } {
  const parsed = flowDefinitionSchema.safeParse(raw);
  if (parsed.success) return { ok: true, def: parsed.data };
  return {
    ok: false,
    result: {
      ok: false,
      error: true,
      message: `${path} failed schema validation`,
      details: parsed.error.issues,
    },
  };
}

function issuesResult(issues: FlowValidationIssue[]): SaveFlowFailure {
  return {
    ok: false,
    error: true,
    message: formatFlowValidationIssues(issues),
    issues,
  };
}

export function createFlowBuilderTools(host: FlowBuilderHost): Record<string, AnyTool> {
  const listTools = defineTool({
    name: FLOW_BUILDER_TOOL_NAMES.listTools,
    description:
      'List every tool the target surface can run from an action node, including JSON input/output schemas. Call before authoring. Takes no arguments.',
    input: z.object({}),
    parallelSafe: true,
    execute: async () => ({ tools: catalogsOf(host).tools }),
  });

  const listFlows = defineTool({
    name: FLOW_BUILDER_TOOL_NAMES.listFlows,
    description:
      'List every flow already registered on the target surface (name, description, schemas). Nested flow ids must come from this catalog. Takes no arguments.',
    input: z.object({}),
    parallelSafe: true,
    execute: async () => ({ flows: catalogsOf(host).flows }),
  });

  const listAgents = defineTool({
    name: FLOW_BUILDER_TOOL_NAMES.listAgents,
    description:
      'List every agent a TransitionRef handoff may target. Takes no arguments.',
    input: z.object({}),
    parallelSafe: true,
    execute: async () => ({ agents: catalogsOf(host).agents }),
  });

  const saveFlow = defineTool({
    name: FLOW_BUILDER_TOOL_NAMES.saveFlow,
    description:
      'Validate a complete FlowDefinition and register it on the target agent. On graph/schema issues, returns the issue list with repair actions instead of throwing — apply those repairs and call once more. Pass the whole definition; do not stream setters.',
    input: saveFlowInputSchema,
    execute: async (args): Promise<SaveFlowResult> => {
      const root = parseDefinition(args.definition, 'definition');
      if (!root.ok) return root.result;

      const dependencies: FlowDefinition[] = [];
      const allIssues: FlowValidationIssue[] = [];
      const index = registryIndexFromCatalogs(catalogsOf(host));

      for (const [i, raw] of (args.dependencies ?? []).entries()) {
        const dep = parseDefinition(raw, `dependencies.${i}`);
        if (!dep.ok) return dep.result;
        const depIssues = validateFlowDefinition(dep.def, index);
        if (depIssues.length > 0) {
          allIssues.push(
            ...depIssues.map((issue) => ({
              ...issue,
              path: `dependencies.${i}${issue.path ? `.${issue.path}` : ''}`,
            })),
          );
        } else {
          dependencies.push(dep.def);
        }
      }

      const rootIssues = validateFlowDefinition(root.def, {
        ...index,
        flows: {
          ...index.flows,
          ...Object.fromEntries(
            dependencies.map((def) => [
              def.name,
              {
                id: def.name,
                ...(def.inputSchema ? { inputSchema: def.inputSchema } : {}),
                ...(def.outputSchema ? { outputSchema: def.outputSchema } : {}),
              },
            ]),
          ),
        },
      });
      allIssues.push(...rootIssues);
      if (allIssues.length > 0) return issuesResult(allIssues);

      const defs = [...dependencies, root.def];
      try {
        await host.getRuntime().addDynamicFlows(defs, {
          agentId: host.targetAgentId,
          replace: args.replace,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, error: true, message };
      }

      return { ok: true, names: defs.map((def) => def.name) };
    },
  });

  return {
    [FLOW_BUILDER_TOOL_NAMES.listTools]: listTools,
    [FLOW_BUILDER_TOOL_NAMES.listFlows]: listFlows,
    [FLOW_BUILDER_TOOL_NAMES.listAgents]: listAgents,
    [FLOW_BUILDER_TOOL_NAMES.saveFlow]: saveFlow,
  };
}
