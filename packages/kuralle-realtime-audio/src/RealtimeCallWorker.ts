import type { RealtimeAudioClient } from '@kuralle-agents/core/realtime';
import type { Runtime } from '@kuralle-agents/core';
import type { WorkerLike, TransportSession, VoiceAgentConfig } from './types.js';
import { VoiceCallSession } from './VoiceCallSession.js';

export type ModelClientFactory = (agent: VoiceAgentConfig) => RealtimeAudioClient;

export interface RealtimeCallWorkerConfig {
  callId: string;
  sessionId: string;
  userId?: string;
  agent: VoiceAgentConfig;
  transport: TransportSession;
  runtime: Runtime;
  createModelClient: ModelClientFactory;
}

export class RealtimeCallWorker implements WorkerLike {
  private config: RealtimeCallWorkerConfig;
  private session: VoiceCallSession | null = null;

  constructor(config: RealtimeCallWorkerConfig) {
    this.config = config;
  }

  get callId(): string {
    return this.config.callId;
  }

  async start(): Promise<void> {
    const { runtime, transport, agent, sessionId, userId, createModelClient } = this.config;
    const modelClient = createModelClient(agent);

    this.session = new VoiceCallSession({
      runtime,
      modelClient,
      transport,
      sessionId,
      userId,
      agentId: agent.id,
    });

    await this.session.start();
  }

  async stop(): Promise<void> {
    if (this.session) {
      await this.session.stop();
      this.session = null;
    }
  }
}
