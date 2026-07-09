import crypto from 'node:crypto';
import type { LanguageModel } from 'ai';
import type { RealtimeAudioClient } from '@kuralle-agents/core/realtime';
import { createRuntime, type HarnessConfig, type Runtime } from '@kuralle-agents/core';
import type { VoiceEngineConfig, VoiceAgentConfig, AcceptCallParams, WorkerLike } from './types.js';
import { RealtimeCallWorker } from './RealtimeCallWorker.js';
import { GeminiLiveSession } from './node/GeminiLiveSession.js';
import { voiceAgentToRuntimeAgent } from './voiceAgentToRuntime.js';

export class VoiceEngine {
  private agents = new Map<string, VoiceAgentConfig>();
  private config: VoiceEngineConfig;
  private activeWorkers = new Map<string, WorkerLike>();
  private runtime: Runtime;
  private modelClientFactory: (agent: VoiceAgentConfig) => RealtimeAudioClient;
  private defaultModel?: LanguageModel;

  constructor(config: VoiceEngineConfig) {
    this.config = config;

    for (const agent of config.agents) {
      this.agents.set(agent.id, agent);
    }

    if (config.createModelClient) {
      this.modelClientFactory = config.createModelClient;
    } else if (config.gemini) {
      const geminiConfig = config.gemini;
      this.modelClientFactory = (agent: VoiceAgentConfig) => {
        return new GeminiLiveSession({
          gemini: geminiConfig,
          agent,
          onEvent: () => {},
        });
      };
    } else {
      throw new Error(
        'VoiceEngine: either "gemini" config or "createModelClient" factory is required',
      );
    }

    const v2Agents = config.agents.map((a) => voiceAgentToRuntimeAgent(a, config.defaultModel));
    const harness: HarnessConfig = {
      agents: v2Agents,
      defaultAgentId: config.defaultAgentId,
      hooks: config.hooks,
      memoryService: config.memoryService,
      voiceMode: true,
    };
    this.runtime = createRuntime(harness);
  }

  async acceptCall(params: AcceptCallParams): Promise<WorkerLike> {
    const agentId = params.agentId ?? this.config.defaultAgentId;
    const agent = this.agents.get(agentId);

    if (!agent) {
      throw new Error(`VoiceEngine: agent "${agentId}" not found`);
    }

    const callId = params.callId ?? crypto.randomUUID();
    const sessionId = params.sessionId ?? `voice-${callId}`;

    const worker: WorkerLike = new RealtimeCallWorker({
      callId,
      sessionId,
      userId: params.userId,
      agent,
      transport: params.transport,
      runtime: this.runtime,
      createModelClient: this.modelClientFactory,
    });

    this.activeWorkers.set(callId, worker);
    return worker;
  }

  getWorker(callId: string): WorkerLike | undefined {
    return this.activeWorkers.get(callId);
  }

  async endCall(callId: string): Promise<void> {
    const worker = this.activeWorkers.get(callId);
    if (worker) {
      await worker.stop();
      this.activeWorkers.delete(callId);
    }
  }

  async shutdown(): Promise<void> {
    const promises = Array.from(this.activeWorkers.keys()).map((id) => this.endCall(id));
    await Promise.allSettled(promises);
  }
}
