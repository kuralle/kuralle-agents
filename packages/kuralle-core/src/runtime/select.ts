import { generateObject } from 'ai';
import { z } from 'zod';
import type { LanguageModel, ModelMessage } from 'ai';
import type { AgentConfig } from '../types/agentConfig.js';
import type { Flow } from '../types/flow.js';
import type { Route } from '../types/route.js';
import type { RunState } from './durable/types.js';

export type HostSelection =
  | { kind: 'enterFlow'; flow: Flow }
  | { kind: 'route'; agentId: string; reason?: string }
  | { kind: 'keep' };

const selectionSchema = z.object({
  action: z.enum(['enterFlow', 'route', 'keep']),
  flowName: z.union([z.string(), z.null()]),
  agentId: z.union([z.string(), z.null()]),
  reason: z.union([z.string(), z.null()]),
});

export interface SelectHostOptions {
  agent: AgentConfig;
  run: RunState;
  model: LanguageModel;
  alwaysRoute?: boolean;
}

export async function selectHostTarget(options: SelectHostOptions): Promise<HostSelection> {
  const { agent, run, model } = options;
  const flows = agent.flows ?? [];
  const routes = agent.routes ?? [];

  if (flows.length === 0 && routes.length === 0) {
    return { kind: 'keep' };
  }

  const latestUser = latestUserMessage(run.messages);
  if (!latestUser) {
    return { kind: 'keep' };
  }

  const completed = run.state.__completedFlows;
  const completedFlows = Array.isArray(completed) ? (completed as string[]) : [];
  const availableFlows = flows.filter((flow) => !completedFlows.includes(flow.name));
  const agentRoutes = routes.filter((route) => route.agent);
  if (availableFlows.length === 1 && agentRoutes.length === 0) {
    return { kind: 'enterFlow', flow: availableFlows[0]! };
  }

  const deterministic = deterministicRouteMatch(latestUser, routes, availableFlows);
  if (deterministic) {
    return deterministic;
  }

  const flowLines = availableFlows
    .map((flow) => `- flow "${flow.name}": ${flow.description}`)
    .join('\n');
  const routeLines = routes
    .map((route, index) => formatRouteLine(route, index))
    .join('\n');

  const { object } = await generateObject({
    model,
    schema: selectionSchema,
    temperature: 0,
    system:
      'You are an internal routing classifier. Choose exactly one action. ' +
      'Output schema fields only — never user-facing prose. ' +
      'Prefer route when a route condition clearly matches; else enterFlow when a flow description matches an uncompleted flow; else keep. Never re-enter a completed flow.',
    prompt:
      `User message:\n${latestUser}\n\n` +
      (completedFlows.length > 0 ? `Completed flows: ${completedFlows.join(', ')}\n\n` : '') +
      (flowLines ? `Available flows:\n${flowLines}\n\n` : '') +
      (routeLines ? `Routes:\n${routeLines}\n\n` : '') +
      'Return enterFlow with flowName, route with agentId, or keep.',
  });

  if (object.action === 'route') {
    const matchedRoute = routes.find(
      (candidate) =>
        (object.agentId != null && candidate.agent === object.agentId) ||
        (object.flowName != null && candidate.flow === object.flowName),
    );
    if (matchedRoute?.flow) {
      const flow = flows.find((candidate) => candidate.name === matchedRoute.flow);
      if (flow) {
        return { kind: 'enterFlow', flow };
      }
    }
    if (matchedRoute?.agent) {
      return { kind: 'route', agentId: matchedRoute.agent, reason: object.reason ?? undefined };
    }
    if (object.agentId != null) {
      if (agent.handoffs?.includes(object.agentId) || agent.agents?.some((child) => child.id === object.agentId)) {
        return { kind: 'route', agentId: object.agentId, reason: object.reason ?? undefined };
      }
    }
  }

  if (object.action === 'enterFlow' && object.flowName != null) {
    const flow = availableFlows.find((candidate) => candidate.name === object.flowName);
    if (flow) {
      return { kind: 'enterFlow', flow };
    }
  }

  if (object.action === 'enterFlow' && availableFlows.length === 1) {
    return { kind: 'enterFlow', flow: availableFlows[0]! };
  }

  return keywordRouteFallback(latestUser, routes, availableFlows);
}

function deterministicRouteMatch(
  message: string,
  routes: Route[],
  availableFlows: Flow[],
): HostSelection | undefined {
  const lower = message.toLowerCase();
  const hits: HostSelection[] = [];

  for (const route of routes) {
    const terms = route.when
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((term) => term.length > 3);
    if (!terms.some((term) => lower.includes(term))) {
      continue;
    }
    if (route.flow) {
      const flow = availableFlows.find((candidate) => candidate.name === route.flow);
      if (flow) {
        hits.push({ kind: 'enterFlow', flow });
      }
    } else if (route.agent) {
      hits.push({ kind: 'route', agentId: route.agent });
    }
  }

  if (hits.length === 1) {
    return hits[0];
  }
  return undefined;
}

function keywordRouteFallback(
  message: string,
  routes: Route[],
  availableFlows: Flow[],
): HostSelection {
  const lower = message.toLowerCase();
  for (const route of routes) {
    if (!route.flow) {
      continue;
    }
    const terms = route.when
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((term) => term.length > 3);
    if (terms.some((term) => lower.includes(term))) {
      const flow = availableFlows.find((candidate) => candidate.name === route.flow);
      if (flow) {
        return { kind: 'enterFlow', flow };
      }
    }
  }
  return { kind: 'keep' };
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
