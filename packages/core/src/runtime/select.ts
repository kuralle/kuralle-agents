import { generateObject } from 'ai';
import { z } from 'zod';
import type { LanguageModel, ModelMessage } from 'ai';
import type { AgentConfig } from '../types/agentConfig.js';
import type { Flow } from '../types/flow.js';
import type { Route } from '../types/route.js';
import type { RunState } from './durable/types.js';
import { availableHostFlows, collectTransferTargets } from './hostControlTools.js';

export type HostSelection =
  | { kind: 'enterFlow'; flow: Flow }
  | { kind: 'route'; agentId: string; reason?: string }
  | { kind: 'keep' };

export interface HostGuardVerdict {
  action: 'keep' | 'enterFlow' | 'transfer';
  flowName?: string;
  targetAgentId?: string;
  reason?: string;
  confidence?: number;
}

const guardSchema = z.object({
  action: z.enum(['keep', 'enterFlow', 'transfer']),
  flowName: z.union([z.string(), z.null()]),
  agentId: z.union([z.string(), z.null()]),
  reason: z.union([z.string(), z.null()]),
  confidence: z.union([z.number(), z.null()]),
});

const dispatcherSchema = z.object({
  action: z.enum(['enterFlow', 'transfer']),
  flowName: z.union([z.string(), z.null()]),
  agentId: z.union([z.string(), z.null()]),
  reason: z.union([z.string(), z.null()]),
});

export interface ClassifyHostOptions {
  agent: AgentConfig;
  run: RunState;
  model: LanguageModel;
  allowKeep: boolean;
  excludeFlowNames?: string[];
}

export async function classifyHostTarget(options: ClassifyHostOptions): Promise<HostGuardVerdict> {
  const { agent, run, model, allowKeep } = options;
  const flows = agent.flows ?? [];
  const routes = agent.routes ?? [];
  const latestUser = latestUserMessage(run.messages);

  if (!latestUser) {
    return { action: 'keep', confidence: 1 };
  }

  const completed = run.state.__completedFlows;
  const completedFlows = Array.isArray(completed) ? (completed as string[]) : [];
  const excluded = new Set(options.excludeFlowNames ?? []);
  const availableFlows = flows.filter(
    (flow) => !completedFlows.includes(flow.name) && !excluded.has(flow.name),
  );
  const transferTargets = collectTransferTargets(agent);
  const flowRoutes = routes.filter((route) => route.flow);
  const hasFlowTargets = availableFlows.length > 0 || flowRoutes.length > 0;
  const hasTransferTargets = transferTargets.length > 0 || routes.some((r) => r.agent);

  if (!hasFlowTargets && !hasTransferTargets) {
    return { action: 'keep', confidence: 1 };
  }

  const flowLines = availableFlows
    .map((flow) => `- flow "${flow.name}": ${flow.description}`)
    .join('\n');
  const routeLines = routes.map((route, index) => formatRouteLine(route, index)).join('\n');
  const transferLines = transferTargets
    .map((t) => `- agent "${t.id}": ${t.descriptions.join('; ')}`)
    .join('\n');

  const schema = allowKeep ? guardSchema : dispatcherSchema;
  const actionHint = allowKeep
    ? 'Return keep, enterFlow with flowName, or transfer with agentId.'
    : 'Return enterFlow with flowName or transfer with agentId. Do not return keep.';

  const { object } = await generateObject({
    model,
    schema,
    temperature: 0,
    system:
      'You are an internal routing classifier. Choose exactly one action. ' +
      'Output schema fields only — never user-facing prose. ' +
      'Reason over semantic descriptions only; never match keywords or substrings.',
    prompt:
      `User message:\n${latestUser}\n\n` +
      (completedFlows.length > 0 ? `Completed flows: ${completedFlows.join(', ')}\n\n` : '') +
      (flowLines ? `Available flows:\n${flowLines}\n\n` : '') +
      (routeLines ? `Routes:\n${routeLines}\n\n` : '') +
      (transferLines ? `Transfer targets:\n${transferLines}\n\n` : '') +
      actionHint,
  });

  const rawConfidence = allowKeep && 'confidence' in object ? object.confidence : null;
  const confidence =
    typeof rawConfidence === 'number' ? rawConfidence : undefined;

  if (object.action === 'transfer') {
    const agentId = object.agentId ?? undefined;
    if (agentId && isValidTransferTarget(agent, agentId)) {
      return {
        action: 'transfer',
        targetAgentId: agentId,
        reason: object.reason ?? undefined,
        confidence,
      };
    }
    const matchedRoute = routes.find(
      (candidate) =>
        (agentId != null && candidate.agent === agentId) ||
        (object.flowName != null && candidate.flow === object.flowName),
    );
    if (matchedRoute?.agent) {
      return {
        action: 'transfer',
        targetAgentId: matchedRoute.agent,
        reason: object.reason ?? undefined,
        confidence,
      };
    }
    if (matchedRoute?.flow) {
      const flow = flows.find((candidate) => candidate.name === matchedRoute.flow);
      if (flow && availableFlows.some((f) => f.name === flow.name)) {
        return {
          action: 'enterFlow',
          flowName: flow.name,
          reason: object.reason ?? undefined,
          confidence,
        };
      }
    }
  }

  if (object.action === 'enterFlow' && object.flowName != null) {
    const flow = availableFlows.find((candidate) => candidate.name === object.flowName);
    if (flow) {
      return {
        action: 'enterFlow',
        flowName: flow.name,
        reason: object.reason ?? undefined,
        confidence,
      };
    }
  }

  if (!allowKeep) {
    if (availableFlows.length === 1) {
      return { action: 'enterFlow', flowName: availableFlows[0]!.name };
    }
    if (transferTargets.length === 1) {
      return { action: 'transfer', targetAgentId: transferTargets[0]!.id };
    }
    throw new Error('Pure dispatcher could not resolve a valid transfer target');
  }

  return { action: 'keep', confidence: confidence ?? 1 as number };
}

/** @deprecated Use classifyHostTarget — kept as alias for test injection. */
export async function selectHostTarget(
  options: Omit<ClassifyHostOptions, 'allowKeep'> & { alwaysRoute?: boolean },
): Promise<HostSelection> {
  const verdict = await classifyHostTarget({ ...options, allowKeep: true });
  if (verdict.action === 'enterFlow' && verdict.flowName) {
    const flow = (options.agent.flows ?? []).find((f) => f.name === verdict.flowName);
    if (flow) {
      return { kind: 'enterFlow', flow };
    }
  }
  if (verdict.action === 'transfer' && verdict.targetAgentId) {
    return { kind: 'route', agentId: verdict.targetAgentId, reason: verdict.reason };
  }
  return { kind: 'keep' };
}

export function verdictToSelection(
  verdict: HostGuardVerdict,
  agent: AgentConfig,
): HostSelection | undefined {
  if (verdict.action === 'keep') {
    return { kind: 'keep' };
  }
  if (verdict.action === 'enterFlow' && verdict.flowName) {
    const flow = (agent.flows ?? []).find((f) => f.name === verdict.flowName);
    if (flow) {
      return { kind: 'enterFlow', flow };
    }
  }
  if (verdict.action === 'transfer' && verdict.targetAgentId) {
    return { kind: 'route', agentId: verdict.targetAgentId, reason: verdict.reason };
  }
  return undefined;
}

function isValidTransferTarget(agent: AgentConfig, targetId: string): boolean {
  if (agent.handoffs?.includes(targetId)) {
    return true;
  }
  if (agent.agents?.some((child) => child.id === targetId)) {
    return true;
  }
  if (agent.routes?.some((route) => route.agent === targetId)) {
    return true;
  }
  return false;
}

function formatRouteLine(route: Route, index: number): string {
  const target = route.agent ? `agent "${route.agent}"` : route.flow ? `flow "${route.flow}"` : 'keep';
  return `- route ${index + 1} → ${target} when: ${route.when}`;
}

function latestUserMessage(messages: ModelMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role === 'user') {
      if (typeof message.content === 'string') {
        return message.content;
      }
      if (Array.isArray(message.content)) {
        const text = message.content
          .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
          .map((part) => part.text)
          .join('');
        if (text) {
          return text;
        }
      }
    }
  }
  return undefined;
}

export { availableHostFlows };
