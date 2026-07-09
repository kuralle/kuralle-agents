/**
 * Factory for the shared voice pipeline components (agent, LLM adapter,
 * filler coordinator) that are common to both transport-backed and
 * LiveKit-room-backed sessions.
 *
 * This is the single place where KuralleRuntimeLLMAdapter and voice.Agent
 * are constructed. Neither KuralleVoiceSession nor KuralleLivekitSession
 * should duplicate this logic.
 */
import { voice } from '@livekit/agents';
import type { Runtime, HarnessConfig } from '@kuralle-agents/core';
import { KuralleRuntimeLLMAdapter, type KuralleRuntimeLike } from '../llm/KuralleRuntimeLLMAdapter.js';
import { FillerCoordinator } from '../filler/FillerCoordinator.js';
import type { VoiceMetricsSink } from '../metrics/types.js';

export interface KuralleVoicePipelineOptions {
  runtime: Runtime | HarnessConfig | KuralleRuntimeLike;
  prompt?: string;
  onKuralleHandoff?: (from: string, to: string) => void | Promise<void>;
  onMetrics?: VoiceMetricsSink;
}

export interface KuralleVoicePipeline {
  readonly agent: voice.Agent;
  readonly ariaLLM: KuralleRuntimeLLMAdapter;
  readonly fillerCoordinator: FillerCoordinator;
}

export function createKuralleVoicePipeline(opts: KuralleVoicePipelineOptions): KuralleVoicePipeline {
  const fillerCoordinator = new FillerCoordinator();

  const ariaLLM = new KuralleRuntimeLLMAdapter({
    runtime: opts.runtime,
    prompt: opts.prompt,
    onKuralleHandoff: opts.onKuralleHandoff,
    onMetrics: opts.onMetrics,
  });

  const agent = new voice.Agent({
    instructions: 'Kuralle-managed voice agent',
    llm: ariaLLM,
  });

  return { agent, ariaLLM, fillerCoordinator };
}
