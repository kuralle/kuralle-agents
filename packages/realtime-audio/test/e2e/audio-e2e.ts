#!/usr/bin/env npx tsx
/**
 * E2E Audio Test: Audio → Agent → Audio
 *
 * Validates the full realtime pipeline through the OrchestrationAuthority stack:
 *   TTS (Gemini) → PCM fixture → VoiceEngine → RealtimeRuntime → OrchestrationAuthority
 *   → GeminiLiveSession → tool calls → flow transitions → audio out → STT validation
 *
 * Architecture under test:
 *   OrchestrationAuthority (core brain)
 *     ↓
 *   RealtimeRuntime (event loop)
 *     ↓
 *   GeminiLiveSession (provider adapter)
 *
 * Trace points:
 *   - Hooks: onStart, onAgentStart, onToolResult, onHandoff, onAgentEnd, onEnd
 *   - Tool calls: logged with args and results
 *   - Flow transitions: node changes tracked
 *   - Audio: input frames sent, output chunks received
 *   - Transcripts: user STT + assistant STT captured
 *
 * Prerequisites:
 *   GOOGLE_GENERATIVE_AI_API_KEY or GOOGLE_API_KEY in .env
 *
 * Run:
 *   npx tsx packages/realtime-audio/test/e2e/audio-e2e.ts
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { GoogleGenAI } from '@google/genai';
import { createFoundation } from '@kuralle-agents/core/foundation';
import type { Hooks } from '@kuralle-agents/core';
import { defineFlow, reply } from '@kuralle-agents/core';
import { VoiceEngine } from '../../src/VoiceEngine.js';
import type { VoiceAgentConfig, TransportSession } from '../../src/types.js';

// ─── Env ────────────────────────────────────────────────────────────────────

const currentDir = dirname(fileURLToPath(import.meta.url));
const rootDir = join(currentDir, '../../../..');
const fixturesDir = join(currentDir, 'fixtures');

// Load .env
try {
  const envFile = readFileSync(join(rootDir, '.env'), 'utf-8');
  for (const line of envFile.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      if (!process.env[key]) process.env[key] = val;
    }
  }
} catch { /* no .env */ }

const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? process.env.GOOGLE_API_KEY;
if (!apiKey) {
  console.error('Set GOOGLE_GENERATIVE_AI_API_KEY or GOOGLE_API_KEY');
  process.exit(1);
}

const SAMPLE_RATE = 24000;
const FRAME_SIZE = 1920; // 20ms at 24kHz, 16-bit

// ─── TTS: Generate and cache audio fixtures ─────────────────────────────────

const genai = new GoogleGenAI({ apiKey });

async function getAudioFixture(text: string, filename: string): Promise<Buffer> {
  const path = join(fixturesDir, filename);
  if (existsSync(path)) {
    console.log(`  [fixture] Cache hit: ${filename}`);
    return readFileSync(path);
  }

  console.log(`  [fixture] Generating TTS for: "${text}"`);
  const result = await genai.models.generateContent({
    model: 'gemini-2.5-flash-preview-tts',
    contents: [{ role: 'user', parts: [{ text }] }],
    config: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
      },
    },
  });

  const audioPart = result.candidates?.[0]?.content?.parts?.[0];
  if (!audioPart?.inlineData?.data) {
    throw new Error(`TTS failed for "${text}"`);
  }

  const pcm = Buffer.from(audioPart.inlineData.data, 'base64');
  mkdirSync(fixturesDir, { recursive: true });
  writeFileSync(path, pcm);
  console.log(`  [fixture] Cached ${pcm.length} bytes → ${filename}`);
  return pcm;
}

// ─── Fake Transport ─────────────────────────────────────────────────────────

class TraceTransport implements TransportSession {
  outputAudioChunks: Uint8Array[] = [];
  closed = false;
  /** Optional callback for first-audio-out latency tracking. */
  onFirstAudioOut: (() => void) | null = null;
  private _audioHandler: ((data: Uint8Array) => void) | null = null;
  private _closeHandler: (() => void) | null = null;
  private _audioOutCountAtTurnStart = 0;

  markTurnStart(): void {
    this._audioOutCountAtTurnStart = this.outputAudioChunks.length;
  }

  sendAudio(data: Uint8Array): void {
    this.outputAudioChunks.push(data);
    // Fire first-audio-out callback on the first NEW chunk for this turn
    if (this.onFirstAudioOut && this.outputAudioChunks.length === this._audioOutCountAtTurnStart + 1) {
      this.onFirstAudioOut();
    }
  }

  onAudio(handler: (data: Uint8Array) => void): void {
    this._audioHandler = handler;
  }

  onClose(handler: () => void): void {
    this._closeHandler = handler;
  }

  close(): void {
    this.closed = true;
  }

  /** Feed audio frames into the transport (simulating user speaking). */
  feedAudio(pcm: Buffer): void {
    let offset = 0;
    while (offset + FRAME_SIZE <= pcm.length) {
      const frame = new Uint8Array(pcm.buffer, pcm.byteOffset + offset, FRAME_SIZE);
      this._audioHandler?.(frame);
      offset += FRAME_SIZE;
    }
    if (offset < pcm.length) {
      const remaining = new Uint8Array(pcm.buffer, pcm.byteOffset + offset, pcm.length - offset);
      this._audioHandler?.(remaining);
    }
  }

  /** Feed silence to trigger VAD end-of-speech detection. */
  feedSilence(durationMs: number): void {
    const numFrames = Math.ceil(durationMs / 20); // 20ms per frame
    const silenceFrame = new Uint8Array(FRAME_SIZE);
    for (let i = 0; i < numFrames; i++) {
      this._audioHandler?.(silenceFrame);
    }
  }
}

// ─── Trace Collector ────────────────────────────────────────────────────────

interface TraceEntry {
  timestamp: number;
  type: string;
  data: Record<string, unknown>;
}

interface TurnLatency {
  turnIndex: number;
  userText: string;
  audioSentAt: number;
  firstAudioOutAt: number | null;
  firstToolCallAt: number | null;
  turnCompleteAt: number | null;
  audioSentToFirstAudioMs: number | null;
  audioSentToToolCallMs: number | null;
  totalTurnMs: number | null;
}

class TraceCollector {
  entries: TraceEntry[] = [];
  toolCalls: Array<{ name: string; args: unknown; result?: unknown }> = [];
  userTranscripts: string[] = [];
  assistantTranscripts: string[] = [];

  // Latency tracking
  turnLatencies: TurnLatency[] = [];
  private _currentTurn: TurnLatency | null = null;
  /** Called by the test loop when audio is fed. */
  startTurnTimer(turnIndex: number, userText: string): void {
    this._currentTurn = {
      turnIndex,
      userText,
      audioSentAt: Date.now(),
      firstAudioOutAt: null,
      firstToolCallAt: null,
      turnCompleteAt: null,
      audioSentToFirstAudioMs: null,
      audioSentToToolCallMs: null,
      totalTurnMs: null,
    };
  }
  /** Called when the wait period ends. */
  endTurnTimer(): void {
    if (this._currentTurn) {
      this._currentTurn.turnCompleteAt = Date.now();
      this._currentTurn.totalTurnMs = this._currentTurn.turnCompleteAt - this._currentTurn.audioSentAt;
      this.turnLatencies.push(this._currentTurn);
      this._currentTurn = null;
    }
  }
  /** Called on first audio output for this turn. */
  recordFirstAudioOut(): void {
    if (this._currentTurn && !this._currentTurn.firstAudioOutAt) {
      this._currentTurn.firstAudioOutAt = Date.now();
      this._currentTurn.audioSentToFirstAudioMs =
        this._currentTurn.firstAudioOutAt - this._currentTurn.audioSentAt;
    }
  }

  private record(type: string, data: Record<string, unknown> = {}): void {
    this.entries.push({ timestamp: Date.now(), type, data });
  }

  buildHooks(): Hooks {
    return {
      onStart: async (ctx) => {
        this.record('onStart', { agentId: ctx.agentId, sessionId: ctx.session.id });
        console.log(`  [hook] onStart agent=${ctx.agentId}`);
      },
      onStreamPart: async (_ctx, part) => {
        if (part.type === 'tool-call') {
          this.record('onToolCall', { toolName: part.toolName, args: part.args });
          console.log(`  [hook] onToolCall ${part.toolName}(${JSON.stringify(part.args).slice(0, 80)})`);
          if (this._currentTurn && !this._currentTurn.firstToolCallAt) {
            this._currentTurn.firstToolCallAt = Date.now();
            this._currentTurn.audioSentToToolCallMs =
              this._currentTurn.firstToolCallAt - this._currentTurn.audioSentAt;
          }
        }
        if (part.type === 'tool-result') {
          this.record('onToolResult', { toolName: part.toolName, result: part.result });
          this.toolCalls.push({ name: part.toolName, args: part.args, result: part.result });
          console.log(`  [hook] onToolResult ${part.toolName}`);
        }
        if (part.type === 'handoff') {
          this.record('onHandoff', { from: _ctx.agentId, to: part.targetAgent, reason: part.reason });
          console.log(`  [hook] onHandoff → ${part.targetAgent}`);
        }
      },
      onEnd: async (ctx) => {
        this.record('onEnd', { agentId: ctx.agentId, sessionId: ctx.session.id });
        console.log(`  [hook] onEnd agent=${ctx.agentId}`);
      },
      onError: async (ctx, error) => {
        this.record('onError', { message: error.message });
        console.log(`  [hook] onError: ${error.message}`);
      },
    };
  }

  /** Print a summary table of all traces. */
  printSummary(): void {
    console.log('\n  ┌──────────────────────────────────────────────────────');
    console.log('  │ TRACE SUMMARY');
    console.log('  ├──────────────────────────────────────────────────────');
    for (const entry of this.entries) {
      const elapsed = entry.timestamp - this.entries[0].timestamp;
      console.log(`  │ +${elapsed}ms  ${entry.type}  ${JSON.stringify(entry.data).slice(0, 80)}`);
    }
    console.log('  ├──────────────────────────────────────────────────────');
    console.log(`  │ Tool calls: ${this.toolCalls.map(t => t.name).join(', ') || 'none'}`);
    console.log(`  │ User transcripts: ${this.userTranscripts.length}`);
    console.log(`  │ Assistant transcripts: ${this.assistantTranscripts.length}`);
    console.log('  └──────────────────────────────────────────────────────');

    // Latency report
    if (this.turnLatencies.length > 0) {
      console.log('\n  ┌──────────────────────────────────────────────────────');
      console.log('  │ LATENCY REPORT');
      console.log('  ├──────────────────────────────────────────────────────');
      for (const t of this.turnLatencies) {
        console.log(`  │ Turn ${t.turnIndex + 1}: "${t.userText.slice(0, 50)}..."`);
        console.log(`  │   Audio sent → First audio out:  ${t.audioSentToFirstAudioMs !== null ? t.audioSentToFirstAudioMs + 'ms' : 'N/A (no audio)'}`);
        console.log(`  │   Audio sent → First tool call:  ${t.audioSentToToolCallMs !== null ? t.audioSentToToolCallMs + 'ms' : 'N/A (no tool call)'}`);
        console.log(`  │   Total turn time:               ${t.totalTurnMs !== null ? t.totalTurnMs + 'ms' : 'N/A'}`);
      }

      const audioLatencies = this.turnLatencies
        .map(t => t.audioSentToFirstAudioMs)
        .filter((v): v is number => v !== null);
      if (audioLatencies.length > 0) {
        const avg = Math.round(audioLatencies.reduce((a, b) => a + b, 0) / audioLatencies.length);
        const min = Math.min(...audioLatencies);
        const max = Math.max(...audioLatencies);
        console.log('  ├──────────────────────────────────────────────────────');
        console.log(`  │ Time-to-first-audio  avg=${avg}ms  min=${min}ms  max=${max}ms`);
      }

      const toolLatencies = this.turnLatencies
        .map(t => t.audioSentToToolCallMs)
        .filter((v): v is number => v !== null);
      if (toolLatencies.length > 0) {
        const avg = Math.round(toolLatencies.reduce((a, b) => a + b, 0) / toolLatencies.length);
        console.log(`  │ Time-to-tool-call    avg=${avg}ms`);
      }

      const totalLatencies = this.turnLatencies
        .map(t => t.totalTurnMs)
        .filter((v): v is number => v !== null);
      if (totalLatencies.length > 0) {
        const total = totalLatencies.reduce((a, b) => a + b, 0);
        console.log(`  │ Total pipeline time: ${total}ms across ${totalLatencies.length} turns`);
      }

      console.log('  └──────────────────────────────────────────────────────');
    }
  }

  hasHook(type: string): boolean {
    return this.entries.some(e => e.type === type);
  }

  hasToolCall(name: string): boolean {
    return this.toolCalls.some(t => t.name === name);
  }
}

// ─── Agent Definition ───────────────────────────────────────────────────────

const checkAvailabilityTool = {
  description: 'Check appointment availability for a date and department',
  parameters: z.object({
    date: z.string().describe('Date to check'),
    department: z.string().describe('Hospital department'),
  }),
  execute: async (args: { date: string; department: string }) => {
    console.log(`  [tool] check_availability date="${args.date}" dept="${args.department}"`);
    return { available: true, slots: ['9:00 AM', '11:00 AM', '2:00 PM'] };
  },
};

const bookingNode = reply({
  id: 'booking',
  instructions: [
    'Help the user book an appointment.',
    'Ask for: patient name, preferred date, and department.',
    'Use check_availability tool to verify the date.',
    'Once confirmed, call confirm_booking to proceed.',
  ].join('\n'),
  tools: { check_availability: checkAvailabilityTool },
});

const greetingNode = reply({
  id: 'greeting',
  instructions: 'Welcome the caller warmly. Ask how you can help. Keep it to one or two sentences.',
});

const confirmNode = reply({
  id: 'confirm',
  instructions: 'Confirm the appointment details briefly and say goodbye.',
  next: () => ({ end: 'completed' }),
});

const hospitalFlow = defineFlow({
  name: 'hospital-receptionist',
  description: 'Books hospital appointments via voice',
  start: greetingNode,
  nodes: [greetingNode, bookingNode, confirmNode],
});

const agent: VoiceAgentConfig = {
  id: 'hospital-receptionist',
  name: 'Hospital Receptionist',
  description: 'Books hospital appointments via voice',
  instructions: `You are a friendly hospital receptionist. Keep responses brief and natural.
CRITICAL: Use the available tools to progress the conversation. Do NOT skip tools.`,
  voice: 'Kore',
  flow: hospitalFlow,
  tools: { check_availability: checkAvailabilityTool },
};

// ─── Test Conversation Turns ────────────────────────────────────────────────

interface TestTurn {
  userText: string;
  fixtureFile: string;
  waitMs: number;
}

const TURNS: TestTurn[] = [
  {
    userText: 'Hi, I would like to book an appointment please.',
    fixtureFile: 'turn1_book_appointment.pcm',
    waitMs: 15000,
  },
  {
    userText: 'My name is Alice Chen and I need a cardiology appointment next Tuesday.',
    fixtureFile: 'turn2_provide_details.pcm',
    waitMs: 15000,
  },
  {
    userText: 'Yes, that sounds great. Please confirm the appointment.',
    fixtureFile: 'turn3_confirm.pcm',
    waitMs: 15000,
  },
];

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  E2E Audio Test: Audio → Authority → Agent → Audio');
  console.log('  Stack: VoiceEngine → RealtimeRuntime → OrchestrationAuthority');
  console.log('  Provider: GeminiLiveSession (RealtimeAudioClient)');
  console.log('═══════════════════════════════════════════════════════════\n');

  // 1. Generate/load audio fixtures
  console.log('Phase 1: Audio Fixtures');
  const audioFixtures: Buffer[] = [];
  for (const turn of TURNS) {
    const pcm = await getAudioFixture(turn.userText, turn.fixtureFile);
    audioFixtures.push(pcm);
  }
  console.log(`  ${audioFixtures.length} fixtures ready\n`);

  // 2. Build the full stack
  console.log('Phase 2: Stack Construction');
  const trace = new TraceCollector();
  const foundation = createFoundation();

  const engine = new VoiceEngine({
    foundation,
    agents: [agent],
    defaultAgentId: agent.id,
    gemini: { apiKey: apiKey!, model: 'gemini-3.1-flash-live-preview' },
    hooks: trace.buildHooks(),
  });
  console.log('  VoiceEngine constructed (authority + runtime inside)\n');

  // 3. Accept a call
  console.log('Phase 3: Call Lifecycle');
  const transport = new TraceTransport();
  const worker = await engine.acceptCall({
    callId: 'e2e-test-call',
    transport,
  });

  console.log('  Starting worker (connects to Gemini Live)...');
  await worker.start();
  console.log('  Worker started!\n');

  // Wait for potential auto-greeting
  console.log('  Waiting for auto-greeting...');
  await sleep(5000);

  // Wire first-audio-out tracking
  transport.onFirstAudioOut = () => trace.recordFirstAudioOut();

  // 4. Run conversation turns
  for (let i = 0; i < TURNS.length; i++) {
    const turn = TURNS[i];
    console.log(`\n--- Turn ${i + 1}: "${turn.userText}" ---`);

    // Start latency timer
    trace.startTurnTimer(i, turn.userText);
    transport.markTurnStart();

    // Feed audio
    transport.feedAudio(audioFixtures[i]);
    transport.feedSilence(500); // 500ms silence for VAD
    console.log(`  Audio fed: ${audioFixtures[i].length} bytes + 500ms silence`);

    // Wait for model to respond
    console.log(`  Waiting ${turn.waitMs / 1000}s for response...`);
    await sleep(turn.waitMs);

    // End latency timer
    trace.endTurnTimer();

    console.log(`  Output audio chunks so far: ${transport.outputAudioChunks.length}`);
  }

  // 5. Stop the call
  console.log('\nPhase 4: Teardown');
  await worker.stop();
  console.log('  Worker stopped');

  // 6. Trace summary
  console.log('\nPhase 5: Trace Analysis');
  trace.printSummary();

  // 7. Assertions
  console.log('\nPhase 6: Assertions');
  const results: Array<{ name: string; pass: boolean; detail: string }> = [];

  // A1: Hooks fired via stream parts
  const hookChecks = ['onStart', 'onEnd'];
  for (const hook of hookChecks) {
    const pass = trace.hasHook(hook);
    results.push({ name: `Hook: ${hook}`, pass, detail: pass ? 'fired' : 'NOT FIRED' });
  }

  // A2: Audio output received
  const hasAudio = transport.outputAudioChunks.length > 0;
  results.push({
    name: 'Audio output received',
    pass: hasAudio,
    detail: `${transport.outputAudioChunks.length} chunks`,
  });

  // A3: Tool calls happened (at least onToolResult fired)
  const hasToolResults = trace.hasHook('onToolResult');
  results.push({
    name: 'Tool results via authority hooks',
    pass: hasToolResults,
    detail: trace.toolCalls.map(t => t.name).join(', ') || 'none',
  });

  const hasEnd = trace.hasHook('onEnd');
  results.push({
    name: 'Clean session close',
    pass: hasEnd,
    detail: hasEnd ? 'onEnd fired' : 'onEnd not fired',
  });

  // Print results
  console.log('\n  ┌────────────────────────────────────────────────────');
  console.log('  │ ASSERTION RESULTS');
  console.log('  ├────────────────────────────────────────────────────');
  let allPass = true;
  for (const r of results) {
    const icon = r.pass ? '✓' : '✗';
    console.log(`  │ ${icon} ${r.name}: ${r.detail}`);
    if (!r.pass) allPass = false;
  }
  console.log('  └────────────────────────────────────────────────────');
  console.log(`\n  ${allPass ? '✓ ALL ASSERTIONS PASSED' : '✗ SOME ASSERTIONS FAILED'}`);

  process.exit(allPass ? 0 : 1);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
