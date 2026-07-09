/**
 * Live Gemini VoiceDriver smoke — createRuntime + GeminiLiveSession.
 * Run: bun run smoke:realtime
 */
import { describe, expect, it } from 'bun:test';
import { config } from 'dotenv';
import { resolve } from 'node:path';
import { z } from 'zod';
import { liveModel } from '../helpers/liveModel.js';
import { defineAgent, defineFlow, reply, collect } from '../../src/authoring/index.js';
import { createRuntime } from '../../src/runtime/Runtime.js';
import { VoiceDriver } from '../../src/runtime/channels/VoiceDriver.js';
import { MemoryStore } from '../../src/session/stores/MemoryStore.js';
import { newSessionId } from '../../src/runtime/openRun.js';
import type {
  RealtimeAudioClient,
  RealtimeEventMap,
  RealtimeSessionConfig,
  RealtimeToolResponse,
} from '../../src/realtime/RealtimeAudioClient.js';
import type { HostSelection } from '../../src/runtime/select.js';
import type { HarnessStreamPart } from '../../src/types/stream.js';

config({ path: resolve(import.meta.dir, '../../.env') });
config({ path: resolve(import.meta.dir, '../../../../.env') });

const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? process.env.GOOGLE_API_KEY;
const describeLive = apiKey ? describe : describe.skip;

class GeminiLiveVoiceAdapter implements RealtimeAudioClient {
  readonly capabilities = {
    turnDetection: true,
    userTranscription: true,
    messageTruncation: true,
    autoToolReplyGeneration: false,
    audioOutput: true,
    manualFunctionCalls: true,
    midSessionInstructionsUpdate: true,
    midSessionToolsUpdate: true,
  };
  readonly provider = 'gemini';
  readonly model: string;

  private readonly session: import('@kuralle-agents/realtime-audio').GeminiLiveSession;
  userTextForTurn = '';

  constructor(session: import('@kuralle-agents/realtime-audio').GeminiLiveSession) {
    this.session = session;
    this.model = session.model;
  }

  get connected(): boolean {
    return this.session.connected;
  }

  on<K extends keyof RealtimeEventMap>(event: K, handler: RealtimeEventMap[K]): void {
    this.session.on(event, handler);
  }

  off<K extends keyof RealtimeEventMap>(event: K, handler: RealtimeEventMap[K]): void {
    this.session.off(event, handler);
  }

  async connect(config: RealtimeSessionConfig): Promise<void> {
    await this.session.connect(config);
  }

  async disconnect(): Promise<void> {
    await this.session.disconnect();
  }

  sendAudio(frame: Uint8Array): void {
    this.session.sendAudio(frame);
  }

  sendToolResponse(responses: RealtimeToolResponse[]): void {
    this.session.sendToolResponse(responses);
  }

  async updateConfig(config: Partial<RealtimeSessionConfig>): Promise<void> {
    await this.session.updateConfig(config);
  }

  requestResponse(instruction?: string): void {
    const text = this.userTextForTurn.trim();
    if (text.length > 0) {
      this.session.requestResponse(text);
      return;
    }
    this.session.requestResponse(instruction);
  }

  async ping(): Promise<boolean> {
    return this.session.ping();
  }
}

describeLive('live VoiceDriver + Gemini realtime smoke', () => {
  it('runs one v2 flow turn with flow-enter and assistant text', async () => {
    const { GeminiLiveSession } = await import('@kuralle-agents/realtime-audio');

    const confirm = reply({
      id: 'confirm',
      instructions:
        'The user gave their name. Reply with exactly: OK Jordan confirmed.',
      next: () => ({ end: 'completed' }),
    });

    const nameCollect = collect({
      id: 'name',
      schema: z.object({ name: z.string().min(1) }),
      required: ['name'],
      maxTurns: 4,
      instructions: () =>
        'Collect the user name. When they say their name is Jordan, call submit_name_data with { name: "Jordan" }.',
      onComplete: () => confirm,
    });

    const flow = defineFlow({
      name: 'name-intake',
      description: 'Collect name via voice',
      start: nameCollect,
      nodes: [nameCollect, confirm],
    });

    const agent = defineAgent({
      id: 'voice-support',
      flows: [flow],
    });

    const geminiSession = new GeminiLiveSession({
      gemini: { apiKey: apiKey! },
      agent: { id: 'voice-support', name: 'Voice', prompt: '', tools: {} },
      onEvent: () => {},
    });

    await geminiSession.connect({ systemInstruction: 'Voice intake', tools: [] });

    const adapter = new GeminiLiveVoiceAdapter(geminiSession);
    adapter.userTextForTurn = 'My name is Jordan.';

    const sessionStore = new MemoryStore();
    const sessionId = newSessionId();
    const hostSelect = async (): Promise<HostSelection> => ({ kind: 'enterFlow', flow });

    const lm = liveModel();
    if (!lm) {
      throw new Error('No live model key for decide/off-audio paths');
    }

    const runtime = createRuntime({
      agents: [{ ...agent, model: lm.model }],
      defaultAgentId: 'voice-support',
      sessionStore,
      defaultModel: lm.model,
      hostSelect,
    });

    const parts: HarnessStreamPart[] = [];
    const handle = runtime.run({
      sessionId,
      input: 'My name is Jordan.',
      driver: new VoiceDriver({ client: adapter }),
    });

    for await (const part of handle.events) {
      parts.push(part);
    }
    const result = await handle;

    await geminiSession.disconnect();

    const assistantText = parts
      .filter((p): p is Extract<HarnessStreamPart, { type: 'text-delta' }> => p.type === 'text-delta')
      .map((p) => p.delta)
      .join('');

    console.log('[smoke:realtime] assistant:', assistantText.slice(0, 300));
    console.log('[smoke:realtime] events:', parts.map((p) => p.type).join(', '));

    expect(parts.some((p) => p.type === 'flow-enter' && p.flow === 'name-intake')).toBe(true);
    expect(parts.some((p) => p.type === 'node-enter')).toBe(true);
    expect(assistantText.length).toBeGreaterThan(0);
    expect(result.text.length).toBeGreaterThan(0);
  }, 180_000);
});
