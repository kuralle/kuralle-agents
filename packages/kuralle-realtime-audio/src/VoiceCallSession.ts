import type { RealtimeAudioClient, RealtimeSessionHandle } from '@kuralle-agents/core/realtime';
import type { Runtime } from '@kuralle-agents/core';
import { VoiceDriver } from '@kuralle-agents/core/runtime';
import type { RealtimeTransportSession } from './V2VoiceTransport.js';

export type { RealtimeTransportSession } from './V2VoiceTransport.js';

export interface VoiceCallSessionParams {
  runtime: Runtime;
  modelClient: RealtimeAudioClient;
  transport: RealtimeTransportSession;
  sessionId: string;
  userId?: string;
  agentId?: string;
  input?: string;
}

export class VoiceCallSession implements RealtimeSessionHandle {
  readonly sessionId: string;
  readonly callId: string;
  private aborted = false;
  private turnAbort: AbortController | null = null;
  private readonly params: VoiceCallSessionParams;

  constructor(params: VoiceCallSessionParams) {
    this.params = params;
    this.sessionId = params.sessionId;
    this.callId = params.sessionId;
  }

  async start(): Promise<void> {
    const { modelClient, transport } = this.params;
    const driver = new VoiceDriver({ client: modelClient });

    transport.onAudio((data) => {
      if (this.aborted) return;
      modelClient.sendAudio(data);
    });

    transport.onClose(() => {
      void this.stop();
    });

    modelClient.on('audio', (data: Uint8Array) => {
      if (this.aborted) return;
      transport.sendAudio(data);
    });

    modelClient.on('interrupted', () => {
      if (this.aborted) return;
      transport.clearAudioBuffer?.();
      this.turnAbort?.abort();
    });

    modelClient.on('disconnected', () => {
      void this.stop();
    });

    modelClient.on('error', () => {
      void this.stop();
    });

    await modelClient.connect({
      systemInstruction: '',
      tools: [],
    });

    this.turnAbort = new AbortController();
    const handle = this.params.runtime.run({
      sessionId: this.sessionId,
      userId: this.params.userId,
      input: this.params.input,
      driver,
      abortSignal: this.turnAbort.signal,
    });

    void handle.catch((err) => {
      if (!this.aborted) {
        console.error('[VoiceCallSession] run failed:', err);
      }
    });
  }

  async stop(): Promise<void> {
    if (this.aborted) return;
    this.aborted = true;
    this.turnAbort?.abort();
    this.turnAbort = null;
    await this.params.modelClient.disconnect().catch(() => {});
    try {
      this.params.transport.close();
    } catch {
      // ignore
    }
  }
}
