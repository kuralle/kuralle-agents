import type { FlowDefinition } from '../types.js';
import type { FlowRegistryIndex, FlowRegistrySchemas, FlowValidationIssue } from './types.js';
import { handoffTarget, walkFlowDefinition } from './walk.js';

export function lookupRegistry(
  table: Record<string, FlowRegistrySchemas> | undefined,
  key: string,
): FlowRegistrySchemas | undefined {
  if (!table) return undefined;
  if (Object.prototype.hasOwnProperty.call(table, key)) return table[key];
  for (const entry of Object.values(table)) {
    if (entry.id === key) return entry;
  }
  return undefined;
}

function registeredKind(
  index: FlowRegistryIndex,
  key: string,
): 'tool' | 'agent' | 'flow' | undefined {
  if (lookupRegistry(index.tools, key)) return 'tool';
  if (lookupRegistry(index.agents, key)) return 'agent';
  if (lookupRegistry(index.flows, key)) return 'flow';
  return undefined;
}

export function validateFlowRefs(def: FlowDefinition, index: FlowRegistryIndex): FlowValidationIssue[] {
  const issues: FlowValidationIssue[] = [];
  const walk = walkFlowDefinition(def);

  for (const location of walk.nodes) {
    if (location.node.kind !== 'action') continue;
    if (!index.tools) continue;
    const tool = location.node.tool;
    if (lookupRegistry(index.tools, tool)) continue;
    const actual = registeredKind(index, tool);
    issues.push({
      code: 'missing-reference',
      path: `${location.path}.tool`,
      message:
        actual === 'agent'
          ? `"${tool}" is a registered AGENT, not a tool — use handoff`
          : actual === 'flow'
            ? `"${tool}" is a registered FLOW, not a tool.`
            : `Tool "${tool}" is not a registered tool.`,
    });
  }

  if (index.agents) {
    for (const visit of walk.transitions) {
      const target = handoffTarget(visit.ref);
      if (target === undefined) continue;
      if (lookupRegistry(index.agents, target)) continue;
      const actual = registeredKind(index, target);
      issues.push({
        code: 'missing-reference',
        path: visit.path,
        message:
          actual === 'tool'
            ? `"${target}" is a registered TOOL, not an agent.`
            : actual === 'flow'
              ? `"${target}" is a registered FLOW, not an agent.`
              : `Handoff target "${target}" is not a registered agent.`,
      });
    }
  }

  if (index.flows) {
    for (const visit of walk.choiceFlows) {
      if (lookupRegistry(index.flows, visit.flowId)) continue;
      const actual = registeredKind(index, visit.flowId);
      issues.push({
        code: 'missing-reference',
        path: visit.path,
        message:
          actual === 'agent'
            ? `"${visit.flowId}" is a registered AGENT, not a flow — use handoff`
            : actual === 'tool'
              ? `"${visit.flowId}" is a registered TOOL, not a flow.`
              : `Flow "${visit.flowId}" is not a registered flow.`,
      });
    }
  }

  return issues;
}
