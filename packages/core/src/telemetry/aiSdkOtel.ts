import { registerTelemetry, type TelemetryOptions } from 'ai';
import { OpenTelemetry } from '@ai-sdk/otel';
import type { Tracer } from '@opentelemetry/api';

/**
 * Opt-in AI SDK OpenTelemetry wiring. Kuralle never registers `@ai-sdk/otel` at
 * import time — v7 traces by default once an integration is registered, so
 * registration is explicit (this helper or `HarnessConfig.aiSdkTelemetry`).
 */
export interface AiSdkTelemetryConfig {
  /** When true, register `@ai-sdk/otel` for this process. Default false. */
  enabled?: boolean;
  /** Passed to the OpenTelemetry integration constructor — not per-call telemetry. */
  tracer?: Tracer;
  recordInputs?: boolean;
  recordOutputs?: boolean;
}

let registered = false;

export function registerAiSdkOpenTelemetry(options?: Pick<AiSdkTelemetryConfig, 'tracer'>): void {
  if (registered) return;
  registerTelemetry(new OpenTelemetry({ tracer: options?.tracer }));
  registered = true;
}

/** @internal Test-only reset; not part of the public API surface. */
export function resetAiSdkOpenTelemetryRegistrationForTests(): void {
  registered = false;
  delete (globalThis as { AI_SDK_TELEMETRY_INTEGRATIONS?: unknown[] }).AI_SDK_TELEMETRY_INTEGRATIONS;
}

export function normalizeAiSdkTelemetryConfig(
  config: AiSdkTelemetryConfig | boolean | undefined,
): AiSdkTelemetryConfig | undefined {
  if (config === true) return { enabled: true };
  if (config === false || config == null) return undefined;
  return config.enabled === false ? undefined : config;
}

export function resolveAiSdkTelemetryOptions(
  config: AiSdkTelemetryConfig | boolean | undefined,
  functionId: string,
): TelemetryOptions | undefined {
  const normalized = normalizeAiSdkTelemetryConfig(config);
  if (!normalized?.enabled) return undefined;
  return {
    isEnabled: true,
    functionId,
    ...(normalized.recordInputs !== undefined ? { recordInputs: normalized.recordInputs } : {}),
    ...(normalized.recordOutputs !== undefined ? { recordOutputs: normalized.recordOutputs } : {}),
  };
}

export function ensureAiSdkTelemetryRegistered(config: AiSdkTelemetryConfig | boolean | undefined): void {
  const normalized = normalizeAiSdkTelemetryConfig(config);
  if (!normalized?.enabled) return;
  registerAiSdkOpenTelemetry({ tracer: normalized.tracer });
}
