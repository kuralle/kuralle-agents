import { afterEach, describe, expect, it } from 'bun:test';
import {
  BasicTracerProvider,
  SimpleSpanProcessor,
  InMemorySpanExporter,
} from '@opentelemetry/sdk-trace-base';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { createRuntime } from '../../src/runtime/Runtime.js';
import { MemoryStore } from '../../src/session/stores/MemoryStore.js';
import {
  registerAiSdkOpenTelemetry,
  resetAiSdkOpenTelemetryRegistrationForTests,
} from '../../src/telemetry/aiSdkOtel.js';
import { stubModel } from '../core-durable/helpers.js';

function integrationCount(): number {
  return (globalThis as { AI_SDK_TELEMETRY_INTEGRATIONS?: unknown[] }).AI_SDK_TELEMETRY_INTEGRATIONS
    ?.length ?? 0;
}

function createRecordingTracer() {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  return { exporter, tracer: provider.getTracer('test') };
}

afterEach(() => {
  resetAiSdkOpenTelemetryRegistrationForTests();
});

describe('AI SDK telemetry opt-in default', () => {
  it('createRuntime without aiSdkTelemetry does not register an integration', () => {
    const before = integrationCount();
    createRuntime({
      agents: [defineAgent({ id: 'quiet', instructions: 'Quiet.', model: stubModel })],
      defaultAgentId: 'quiet',
      sessionStore: new MemoryStore(),
    });
    expect(integrationCount()).toBe(before);
  });

  it('registerAiSdkOpenTelemetry adds a global integration', () => {
    const before = integrationCount();
    registerAiSdkOpenTelemetry({});
    expect(integrationCount()).toBe(before + 1);
  });

  it('createRuntime with aiSdkTelemetry enabled registers exactly one integration', () => {
    const { tracer } = createRecordingTracer();
    createRuntime({
      agents: [defineAgent({ id: 'traced', instructions: 'Traced.', model: stubModel })],
      defaultAgentId: 'traced',
      sessionStore: new MemoryStore(),
      aiSdkTelemetry: { enabled: true, tracer },
    });
    expect(integrationCount()).toBe(1);
  });
});
