import type { FlowDefinition, JsonSchema } from '../types.js';
import { precedingIds } from './schema-flow.js';
import type { GraphSchemaInference } from './schema-flow.js';
import { lookupRegistry } from './refs.js';
import { schemaCompatibility } from './schema-utils.js';
import type {
  FlowRegistryIndex,
  FlowValidationIssue,
  FlowValidationRepairAction,
  FlowValidationRepairOperation,
  FlowValidationRepairSource,
} from './types.js';
import { walkFlowDefinition } from './walk.js';

function nodeIndexFromPath(path: string): number | undefined {
  const match = /^nodes\.(\d+)/.exec(path);
  return match ? Number(match[1]) : undefined;
}

function legalSources(
  def: FlowDefinition,
  nodeId: string,
  expectedSchema: JsonSchema | undefined,
  nodeOutputs: Map<string, JsonSchema | undefined>,
): FlowValidationRepairSource[] {
  const walk = walkFlowDefinition(def);
  const preceding = precedingIds(walk, def.start, nodeId);
  const sources: FlowValidationRepairSource[] = [
    {
      source: { input: true, path: '' },
      ...(def.inputSchema ? { schema: def.inputSchema } : {}),
      compatibility: schemaCompatibility(def.inputSchema, expectedSchema),
    },
  ];
  for (const id of preceding) {
    const schema = nodeOutputs.get(id);
    sources.push({
      source: { node: id, path: '' },
      ...(schema ? { schema } : {}),
      compatibility: schemaCompatibility(schema, expectedSchema),
    });
  }
  return sources.filter((source) => source.compatibility !== 'incompatible');
}

function repairFor(
  issue: FlowValidationIssue,
  def: FlowDefinition,
  index: FlowRegistryIndex,
  inference: GraphSchemaInference,
): FlowValidationRepairAction | undefined {
  const walk = walkFlowDefinition(def);
  const nodeIndex = nodeIndexFromPath(issue.path);
  const location = nodeIndex === undefined ? undefined : walk.nodes[nodeIndex];
  const nodeId = location?.node.id;
  const expectedSchema =
    location?.node.kind === 'action'
      ? lookupRegistry(index.tools, location.node.tool)?.inputSchema
      : def.outputSchema;
  const sources = nodeId ? legalSources(def, nodeId, expectedSchema, inference.nodeOutputs) : [];

  const operation = ((): FlowValidationRepairOperation | undefined => {
    switch (issue.code) {
      case 'incompatible-schema':
        return 'update-node';
      case 'invalid-map-reference':
        return 'set-mapping-source';
      case 'invalid-predicate-reference':
      case 'predicate-too-deep':
        return 'set-predicate';
      case 'invalid-template':
        return 'set-template';
      case 'missing-reference':
      case 'invalid-reply':
      case 'duplicate-node-id':
        return 'update-node';
      case 'unresolved-transition':
      case 'missing-start':
      case 'inline-transition-target':
        return 'set-transition';
      case 'unreachable-node':
        return 'remove-node';
    }
  })();
  if (!operation) return undefined;

  return {
    operation,
    arguments: nodeId ? { nodeId } : { targetPath: issue.path },
    legalSources: sources,
  };
}

export function addFlowValidationRepairActions(
  def: FlowDefinition,
  index: FlowRegistryIndex,
  issues: FlowValidationIssue[],
  inference: GraphSchemaInference,
): FlowValidationIssue[] {
  return issues.map((issue) => {
    const repair = repairFor(issue, def, index, inference);
    return repair ? { ...issue, repair } : issue;
  });
}
