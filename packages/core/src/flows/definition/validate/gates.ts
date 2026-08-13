import type { FlowDefinition, JsonSchema } from '../types.js';
import { validatePredicateTree, validateScopedPath, type PathContext } from './paths.js';
import type { GraphSchemaInference } from './schema-flow.js';
import type { FlowValidationIssue } from './types.js';

function producesResult(kind: FlowDefinition['nodes'][number]['kind']): boolean {
  return kind === 'collect' || kind === 'action' || kind === 'decide';
}

export function validateFlowGates(
  def: FlowDefinition,
  inference: GraphSchemaInference,
): FlowValidationIssue[] {
  if (!def.gates || def.gates.length === 0) return [];

  const issues: FlowValidationIssue[] = [];
  const seen = new Set<string>();
  const results = new Map<string, JsonSchema | undefined>();
  for (const node of def.nodes) {
    if (!producesResult(node.kind)) continue;
    results.set(node.id, inference.nodeOutputs.get(node.id));
  }

  let terminalState: JsonSchema | undefined;
  for (const state of inference.nodeState.values()) {
    terminalState = state;
  }

  const ctx: PathContext = {
    input: def.inputSchema,
    state: terminalState,
    results,
  };

  for (let index = 0; index < def.gates.length; index++) {
    const gate = def.gates[index]!;
    const path = `gates.${index}`;
    if (seen.has(gate.id)) {
      issues.push({
        code: 'invalid-gate',
        path: `${path}.id`,
        message: `Gate id "${gate.id}" is duplicated.`,
      });
    } else {
      seen.add(gate.id);
    }

    if (gate.kind === 'predicate') {
      issues.push(...validatePredicateTree(gate.when, `${path}.when`, ctx));
      continue;
    }

    gate.inputs.forEach((input, inputIndex) => {
      const issue = validateScopedPath(
        input,
        `${path}.inputs.${inputIndex}`,
        ctx,
        'invalid-predicate-reference',
      );
      if (issue) issues.push(issue);
    });
  }

  return issues;
}
