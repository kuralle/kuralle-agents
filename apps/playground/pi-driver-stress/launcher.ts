import { createOpenAI } from '@ai-sdk/openai';
import { createModels } from '@earendil-works/pi-ai';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import {
  createRuntime,
  otelSink,
  type AgentConfig,
  type FlowNode,
  type SessionStore,
  type TraceStore,
} from '@kuralle-agents/core';
import { PiDriver } from '@kuralle-agents/pi-driver';
import { config as loadEnv } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildKitchenSinkAgent, buildOkfAgent } from './kitchenSink.js';

const appDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(appDir, '../../..');
loadEnv({ path: resolve(repoRoot, '.env'), quiet: true });

const apiKey = process.env.OPENAI_API_KEY?.trim();
if (!apiKey) throw new Error('OPENAI_API_KEY is required in the repository root .env file.');

const scenario = process.env.KURALLE_STRESS_SCENARIO?.trim();
if (!scenario) throw new Error('KURALLE_STRESS_SCENARIO is required. Use the stress runner instead of launching this module directly.');

const modelId = process.env.OPENAI_MODEL?.trim() || 'gpt-4.1-mini';
const openai = createOpenAI({ apiKey });
const aiSdkModel = openai(modelId);

async function loadAgent(): Promise<AgentConfig> {
  if (scenario === 'kitchen-sink') return buildKitchenSinkAgent(aiSdkModel);
  if (scenario === 'okf') return buildOkfAgent(aiSdkModel);

  const source = process.env.KURALLE_STRESS_SOURCE?.trim();
  if (!source) throw new Error(`KURALLE_STRESS_SOURCE is required for scenario ${scenario}.`);
  const sourcePath = resolve(repoRoot, source);
  const mod = await import(pathToFileURL(sourcePath).href) as Record<string, unknown>;
  const candidate = mod.default ?? mod.agent;
  if (!isAgentConfig(candidate)) {
    throw new Error(`${source} must default-export an AgentConfig for CLI stress execution.`);
  }
  return forceModel(candidate, aiSdkModel);
}

const agent = await loadAgent();

/**
 * CLI-loadable runtime factory. The CLI supplies its file stores, while this
 * launcher supplies the selected driver and optional OTLP sink.
 */
export function buildRuntime(
  _sessionId?: string,
  sessionStore?: SessionStore,
  traceStore?: TraceStore,
) {
  const driverName = process.env.KURALLE_STRESS_DRIVER?.trim() || 'pi';
  if (driverName !== 'ai-sdk' && driverName !== 'pi') {
    throw new Error(`Unknown KURALLE_STRESS_DRIVER: ${driverName}`);
  }

  const sinks = [];
  const otlpEndpoint = process.env.KURALLE_STRESS_OTLP_ENDPOINT?.trim();
  if (otlpEndpoint) {
    sinks.push(otelSink({
      endpoint: otlpEndpoint,
      batchSize: 1,
      serviceName: 'kuralle-pi-driver-stress',
    }));
  }

  let driver;
  if (driverName === 'pi') {
    const models = createModels();
    models.setProvider(openaiProvider());
    const piModel = models.getModel('openai', modelId);
    if (!piModel) throw new Error(`Pi did not register openai:${modelId}.`);
    driver = new PiDriver({
      model: piModel,
      models,
      getApiKey: () => apiKey,
      maxSteps: 16,
    });
  }

  return createRuntime({
    agents: [agent],
    defaultAgentId: agent.id,
    defaultModel: aiSdkModel,
    ...(driver ? { driver } : {}),
    ...(sessionStore ? { sessionStore } : {}),
    tracing: {
      ...(traceStore ? { store: traceStore } : {}),
      ...(sinks.length > 0 ? { sinks } : {}),
    },
  });
}

export default buildRuntime;

function isAgentConfig(value: unknown): value is AgentConfig {
  return typeof value === 'object' && value !== null && typeof (value as AgentConfig).id === 'string';
}

/** Keep the two test lanes on exactly one model, including per-node overrides. */
function forceModel(config: AgentConfig, model: typeof aiSdkModel): AgentConfig {
  const flows = config.flows?.map((flow) => {
    const start = flow.start;
    return {
      ...flow,
      nodes: flow.nodes.map((node) => forceNodeModel(node, model)),
      start: typeof start === 'function'
        ? () => forceNodeModel(start(), model)
        : forceNodeModel(start, model),
    };
  });

  return {
    ...config,
    model,
    ...(config.controlModel ? { controlModel: model } : {}),
    ...(flows ? { flows } : {}),
    ...(config.agents ? { agents: config.agents.map((child) => forceModel(child, model)) } : {}),
  };
}

function forceNodeModel<T extends FlowNode>(node: T, model: typeof aiSdkModel): T {
  if (node.kind !== 'reply' || !node.model) return node;
  return { ...node, model } as T;
}
