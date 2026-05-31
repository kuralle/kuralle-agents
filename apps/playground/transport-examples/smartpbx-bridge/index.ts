/**
 * SmartPBX Bridge for Kuralle Voice Agents
 *
 * Complete end-to-end example showing how to bridge SmartPBX telephony
 * to Kuralle voice agents with automatic audio format detection
 * and optimized conversion paths.
 *
 * Features:
 * - ✅ Passthrough mode for 24kHz PCM16 (ZERO conversion - optimal!)
 * - ⚡ Sample rate conversion (8kHz ↔ 24kHz)  
 * - 🔧 G.711 μ-law conversion (telephony standard)
 * - 🔄 Opus codec support (optional, CPU intensive)
 * - 🎹 DTMF support
 *
 * Audio Format Priority (Best to Worst):
 * 1. PASSTHROUGH: 24kHz PCM16 → 0ms conversion
 * 2. RESAMPLE: 8kHz PCM16 → ~1-2ms
 * 3. G.711 μ-law → ~2-4ms
 * 4. Opus → ~5-10ms (requires opusscript)
 *
 * RECOMMENDED: Configure SmartPBX to send PCM16 @ 24kHz for best performance!
 *
 * Usage:
 *   bun run index.ts
 *
 * SmartPBX Configuration:
 *   Encoding: PCM16
 *   Sample Rate: 24000 Hz
 *   WebSocket URL: wss://your-domain.com/media-stream
 */

import { Hono } from 'hono';
import { WebSocketServer, WebSocket } from 'ws';
import { serve } from '@hono/node-server';
import type { Server as HttpServer } from 'node:http';
import { KuralleVoiceSession } from '@kuralle-agents/livekit-plugin';
import {
  SmartPBXTransportAdapter,
  type SmartPBXSessionState,
} from '@kuralle-agents/livekit-plugin-transport-smartpbx';
import { wireTools } from '../../_shared/runtime/v2Tools.js';
import { createRuntime, defineAgent } from '@kuralle-agents/core';
import { openai } from '@ai-sdk/openai';
import { GeminiLiveSTT, GeminiLiveTTS } from '@kuralle-agents/livekit-plugin/gemini';
import { initializeLogger } from '@livekit/agents';
import { tools } from './tools.js';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// ============================================================================
// Configuration
// ============================================================================

const PORT = parseInt(process.env.PORT || '8080');
const HOST = process.env.HOST || '0.0.0.0';
const WS_PATH = '/media-stream';
const ARRIAFLOW_SAMPLE_RATE = 24000;
initializeLogger({ pretty: true });

// Opus codec state (lazy loaded via require)
let opusDecoder: any = null;
let opusEncoder: any = null;
let opusLoadAttempted = false;

// ============================================================================
// Create Kuralle Runtime with Tools
// ============================================================================

const wired = wireTools(tools as Record<string, { description: string; inputSchema: unknown; execute: (...args: unknown[]) => unknown }>);
const runtime = createRuntime({
  agents: [
    defineAgent({
      id: 'support',
      name: 'Customer Support',
      model: openai('gpt-4o-mini'),
      instructions: `You are a friendly customer support representative.

Guidelines:
- Greet the caller warmly
- Ask for their order ID if they want to check order status
- Use the lookupOrder tool to find order information
- If the customer wants to speak to a human, use transferToHuman
- Keep responses conversational and friendly
- Be concise - phone conversations should be brief`,
      tools: wired.tools,
      effectTools: wired.effectTools,
    }),
  ],
  defaultAgentId: 'support',
  defaultModel: openai('gpt-4o-mini'),
  voiceMode: true,
  tools: wired.effectTools,
});

// ============================================================================
// Audio Conversion Utilities
// ============================================================================

const MU_LAW_MAX = 0x1FFF;
const MU_LAW_BIAS = 0x84;

/**
 * Lazy load Opus codec using require (works with createRequire)
 */
function loadOpusCodec(): boolean {
  if (opusLoadAttempted) {
    return opusDecoder !== null && opusEncoder !== null;
  }

  opusLoadAttempted = true;

  try {
    const OpusScript = require('opusscript');
    opusDecoder = new OpusScript(ARRIAFLOW_SAMPLE_RATE, 1);
    opusEncoder = new OpusScript(ARRIAFLOW_SAMPLE_RATE, 1);
    console.log('✅ Opus codec loaded successfully');
    return true;
  } catch (error) {
    console.warn('⚠️ Opus codec not available:', error instanceof Error ? error.message : error);
    console.warn('   Install opusscript to support Opus audio: bun add opusscript');
    return false;
  }
}

/**
 * Convert 16-bit PCM (base64) → μ-law (base64)
 */
function pcmToMulaw(pcmBase64: string, targetSampleRate = 8000): string {
  const pcmBuffer = Buffer.from(pcmBase64, 'base64');
  const sourceSampleRate = ARRIAFLOW_SAMPLE_RATE;
  const ratio = sourceSampleRate / targetSampleRate;

  const samples = pcmBuffer.length / 2;
  const outputSamples = Math.floor(samples / ratio);
  const mulawBuffer = Buffer.alloc(outputSamples);

  for (let i = 0, j = 0; j < outputSamples; i++, j++) {
    const sourceIndex = Math.floor(i * ratio) * 2;
    if (sourceIndex + 1 >= pcmBuffer.length) break;

    const sample = pcmBuffer.readInt16LE(sourceIndex);
    let sign = (sample >> 8) & 0x80;
    let magnitude = Math.abs(sample);

    if (magnitude > MU_LAW_MAX) magnitude = MU_LAW_MAX;
    magnitude += MU_LAW_BIAS;

    let exponent = 7;
    for (let expMask = 0x4000; (magnitude & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) { }

    let mantissa = (magnitude >> ((exponent === 0) ? 4 : (exponent + 3))) & 0x0F;
    let mulaw = ~(sign | (exponent << 4) | mantissa);

    mulawBuffer[j] = mulaw & 0xFF;
  }

  return mulawBuffer.toString('base64');
}

/**
 * Convert μ-law (base64) → 16-bit PCM (base64)
 */
function mulawToPcm(mulawBase64: string, sourceSampleRate = 8000): string {
  const targetRate = ARRIAFLOW_SAMPLE_RATE;
  const ratio = targetRate / sourceSampleRate;

  const mulawBuffer = Buffer.from(mulawBase64, 'base64');
  const outputSamples = mulawBuffer.length * Math.floor(ratio);
  const pcmBuffer = Buffer.alloc(outputSamples * 2);

  for (let i = 0; i < outputSamples; i++) {
    const sourceIndex = Math.floor(i / ratio);
    if (sourceIndex >= mulawBuffer.length) break;

    let mulawByte = ~mulawBuffer[sourceIndex];
    let sign = mulawByte & 0x80;
    let exponent = (mulawByte >> 4) & 0x07;
    let mantissa = mulawByte & 0x0F;

    let magnitude = ((mantissa << 3) + 0x84) << exponent;
    magnitude -= MU_LAW_BIAS;

    let sample = sign ? -magnitude : magnitude;
    pcmBuffer.writeInt16LE(sample, i * 2);
  }

  return pcmBuffer.toString('base64');
}

/**
 * Resample PCM16 audio between sample rates
 * Uses linear interpolation
 */
function resamplePCM(pcmBase64: string, sourceRate: number, targetRate: number): string {
  if (sourceRate === targetRate) {
    return pcmBase64; // PASSTHROUGH!
  }

  const pcmBuffer = Buffer.from(pcmBase64, 'base64');
  const samples = pcmBuffer.length / 2;
  const ratio = sourceRate / targetRate;
  const outputSamples = Math.floor(samples / ratio);
  const outputBuffer = Buffer.alloc(outputSamples * 2);

  for (let i = 0; i < outputSamples; i++) {
    const sourceIndex = Math.floor(i * ratio) * 2;
    if (sourceIndex + 1 >= pcmBuffer.length) break;
    const sample = pcmBuffer.readInt16LE(sourceIndex);
    outputBuffer.writeInt16LE(sample, i * 2);
  }

  return outputBuffer.toString('base64');
}

/**
 * Decode Opus audio to PCM16
 */
function decodeOpus(opusBase64: string): Buffer | null {
  if (!loadOpusCodec()) {
    return null;
  }

  try {
    const opusData = Buffer.from(opusBase64, 'base64');
    const pcmBuffer = opusDecoder.decode(opusData);
    
    if (!pcmBuffer || pcmBuffer.length === 0) {
      console.warn('Opus decoding failed: empty buffer');
      return null;
    }

    return pcmBuffer;
  } catch (error) {
    console.error('Opus decode error:', error);
    return null;
  }
}

/**
 * Encode PCM16 audio to Opus
 */
function encodeOpus(pcmBuffer: Buffer): string | null {
  if (!loadOpusCodec()) {
    return null;
  }

  try {
    const samplesPerChannel = pcmBuffer.length / 2;
    const opusBuffer = opusEncoder.encode(pcmBuffer, samplesPerChannel);
    
    if (!opusBuffer || opusBuffer.length === 0) {
      console.warn('Opus encoding failed: empty buffer');
      return null;
    }
    
    return opusBuffer.toString('base64');
  } catch (error) {
    console.error('Opus encode error:', error);
    return null;
  }
}

// ============================================================================
// SmartPBX Session Interface
// ============================================================================

interface SmartPBXSession extends SmartPBXSessionState {
  callId: string;
  accountId: string;
  callerIdNumber?: string;
  calleeIdNumber?: string;
  otherLegCallId?: string;
  mediaFormat?: {
    encoding: 'g711_ulaw' | 'pcm16' | 'opus';
    sampleRate: string;
  };
  isActive: boolean;
  voiceSession?: KuralleVoiceSession;
  transport?: SmartPBXTransportAdapter;
  hasSpoken: boolean;
  usePassthrough: boolean;
  conversionType: 'passthrough' | 'resample' | 'g711_mulaw' | 'opus_decode';
}

// ============================================================================
// Hono App
// ============================================================================

const app = new Hono();

app.get('/health', (c) => {
  const opusAvailable = loadOpusCodec();
  return c.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    websocket_endpoint: `wss://${c.req.header('host') || 'localhost:8080'}${WS_PATH}`,
    opus_codec_available: opusAvailable,
    supported_formats: [
      'PCM16 @ 24kHz (passthrough - optimal)',
      'PCM16 @ 8kHz (resample)',
      'G.711 μ-law @ 8kHz (convert)',
      opusAvailable ? 'Opus (decode/encode)' : 'Opus (not available)',
    ],
    recommended_config: {
      encoding: 'pcm16',
      sampleRate: '24000',
      reason: 'Enables zero-conversion passthrough mode',
    },
  });
});

app.get('/', (c) => {
  const host = c.req.header('host') || 'localhost:8080';
  return c.json({
    message: 'SmartPBX Bridge for Kuralle Voice Agents v2.0',
    features: [
      'Passthrough mode for 24kHz PCM16 (zero conversion)',
      'Sample rate conversion (8kHz ↔ 24kHz)',
      'G.711 μ-law conversion',
      'Opus codec support (optional)',
      'DTMF support',
    ],
    webhook_url: `http://${host}/`,
    websocket_endpoint: `wss://${host}${WS_PATH}`,
  });
});

app.post('/', (c) => {
  const host = c.req.header('host') || 'localhost:8080';
  c.header('Content-Type', 'application/xml');

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${host}${WS_PATH}" />
  </Connect>
</Response>`;

  return c.text(twiml);
});

// ============================================================================
// WebSocket Server
// ============================================================================

const httpServer = serve({
  fetch: app.fetch,
  port: PORT,
  hostname: HOST,
}) as HttpServer;
const wss = new WebSocketServer({ server: httpServer, path: WS_PATH });
const activeSessions = new Map<string, SmartPBXSession>();
let globalMediaEventCount = 0;

wss.on('connection', (ws: WebSocket, req: any) => {
  const sessionId = crypto.randomUUID();
  console.log(`[${sessionId}] 📞 SmartPBX connected`);

  const session: SmartPBXSession = {
    callId: '',
    accountId: '',
    isActive: false,
    hasSpoken: false,
    usePassthrough: false,
    conversionType: 'passthrough',
  };

  ws.on('message', (data: Buffer) => {
    try {
      const msg = JSON.parse(data.toString());

      switch (msg.event) {
        case 'connected':
          console.log(`[${sessionId}] SmartPBX connection established`);
          break;

        case 'start':
          session.callId = msg.start.callId;
          session.accountId = msg.start.accountId;
          session.callerIdNumber = msg.start.callerIdNumber;
          session.calleeIdNumber = msg.start.calleeIdNumber;
          session.otherLegCallId = msg.start.otherLegCallId;
          session.isActive = true;
          session.hasSpoken = false;

          if (msg.start.mediaFormat) {
            session.mediaFormat = {
              encoding: msg.start.mediaFormat.encoding,
              sampleRate: msg.start.mediaFormat.sampleRate,
            };

            const sampleRate = parseInt(session.mediaFormat.sampleRate, 10);

            if (session.mediaFormat.encoding === 'pcm16' && sampleRate === ARRIAFLOW_SAMPLE_RATE) {
              session.usePassthrough = true;
              session.conversionType = 'passthrough';
              console.log(`[${sessionId}] ✅ PASSTHROUGH MODE: 24kHz PCM16 (zero conversion!)`);
            } else if (session.mediaFormat.encoding === 'pcm16') {
              session.usePassthrough = false;
              session.conversionType = 'resample';
              console.log(`[${sessionId}] ⚡ RESAMPLE MODE: PCM16 ${sampleRate}kHz → 24kHz`);
            } else if (session.mediaFormat.encoding === 'g711_ulaw') {
              session.usePassthrough = false;
              session.conversionType = 'g711_mulaw';
              console.log(`[${sessionId}] 🔧 G.711 μ-law MODE: ${sampleRate}kHz → PCM16 24kHz`);
            } else if (session.mediaFormat.encoding === 'opus') {
              session.usePassthrough = false;
              session.conversionType = 'opus_decode';
              if (loadOpusCodec()) {
                console.log(`[${sessionId}] 🔄 OPUS MODE: ${sampleRate}kHz → PCM16 24kHz`);
              } else {
                console.error(`[${sessionId}] ❌ CRITICAL: Opus codec not available!`);
                console.error(`     Install opusscript: bun add opusscript`);
              }
            } else {
              console.warn(`[${sessionId}] ⚠️ Unknown encoding: ${session.mediaFormat.encoding}`);
              session.conversionType = 'resample';
            }
          }

          console.log(`[${sessionId}] Call started: ${session.callId}`);
          startVoiceSession(ws, session);
          break;

        case 'media':
          if (session.isActive && session.voiceSession) {
            handleIncomingAudio(ws, session, msg.media);
          }
          break;

        case 'stop':
        case 'hangup':
          console.log(`[${sessionId}] Call ${msg.event}`);
          session.isActive = false;
          endVoiceSession(ws, session);
          break;

        case 'dtmf':
          console.log(`[${sessionId}] DTMF: ${msg.dtmf.digit}`);
          handleDTMF(ws, session, msg.dtmf);
          break;

        default:
          console.log(`[${sessionId}] Unknown event: ${msg.event}`);
      }

    } catch (error) {
      console.error(`[${sessionId}] Error handling message:`, error);
    }
  });

  ws.on('close', () => {
    console.log(`[${sessionId}] SmartPBX disconnected`);
    if (session.isActive && session.voiceSession) {
      session.voiceSession.close().catch(console.error);
      session.transport?.close().catch(console.error);
      session.isActive = false;
    }
  });

  ws.on('error', (error) => {
    console.error(`[${sessionId}] WebSocket error:`, error);
  });
});

// ============================================================================
// Voice Session Management
// ============================================================================

async function startVoiceSession(ws: WebSocket, session: SmartPBXSession) {
  try {
    const voiceSession = new KuralleVoiceSession({
      runtime: runtime,
      stt: new GeminiLiveSTT(),
      tts: new GeminiLiveTTS(),
      greeting: 'Hello! Thank you for calling customer support. How can I help you today?',
    });

    const transport = new SmartPBXTransportAdapter({
      socket: ws,
      session,
      sampleRate: ARRIAFLOW_SAMPLE_RATE,
      onAudioFrame: (frame) => {
        sendAudioToSmartPBX(ws, session, frame);
      },
    });
    await voiceSession.start(transport);
    session.voiceSession = voiceSession;
    session.transport = transport;

    console.log(`[${session.callId}] Voice session started`);

  } catch (error) {
    console.error(`[${session.callId}] Failed to start voice session:`, error);
    sendError(ws, 'Failed to start voice session');
  }
}

async function endVoiceSession(ws: WebSocket, session: SmartPBXSession) {
  if (session.voiceSession) {
    console.log(`[${session.callId}] Ending voice session`);

    // Signal end-of-audio turn now that the call has ended
    session.transport?.audioInput.endCurrentTurn();

    await session.voiceSession.close();
    await session.transport?.close();
    session.voiceSession = undefined;
    session.transport = undefined;
  }
}

// ============================================================================
// Audio Handling
// ============================================================================

function handleIncomingAudio(ws: WebSocket, session: SmartPBXSession, media: any) {
  if (!session.mediaFormat || !session.voiceSession) {
    return;
  }

  try {
    const { payload } = media;
    let pcmData: string;
    const sampleRate = parseInt(session.mediaFormat.sampleRate, 10);

    switch (session.conversionType) {
      case 'passthrough':
        pcmData = payload;
        if (globalMediaEventCount % 100 === 1) {
          console.log(`[${session.callId}] ✅ PASSTHROUGH (0ms) - Event #${globalMediaEventCount}`);
        }
        break;

      case 'resample':
        pcmData = resamplePCM(payload, sampleRate, ARRIAFLOW_SAMPLE_RATE);
        if (globalMediaEventCount % 100 === 1) {
          console.log(`[${session.callId}] ⚡ RESAMPLE (~1-2ms) - Event #${globalMediaEventCount}`);
        }
        break;

      case 'g711_mulaw':
        const pcm24kHz = mulawToPcm(payload, sampleRate);
        pcmData = resamplePCM(pcm24kHz, sampleRate, ARRIAFLOW_SAMPLE_RATE);
        if (globalMediaEventCount % 100 === 1) {
          console.log(`[${session.callId}] 🔧 G.711 μ-law (~2-4ms) - Event #${globalMediaEventCount}`);
        }
        break;

      case 'opus_decode':
        const pcmBuffer = decodeOpus(payload);
        if (!pcmBuffer) {
          console.error(`[${session.callId}] ❌ Opus decode failed`);
          return;
        }
        pcmData = pcmBuffer.toString('base64');
        if (globalMediaEventCount % 100 === 1) {
          console.log(`[${session.callId}] 🔄 OPUS (~5-10ms) - Event #${globalMediaEventCount}`);
        }
        break;

      default:
        console.warn(`[${session.callId}] Unknown conversion type`);
        return;
    }

    globalMediaEventCount++;

    if (session.transport) {
      const pcmBuffer = Buffer.from(pcmData, 'base64');
      const float32Array = new Float32Array(pcmBuffer.length / 2);
      for (let i = 0; i < float32Array.length; i++) {
        float32Array[i] = pcmBuffer.readInt16LE(i * 2) / 0x7FFF;
      }

      // Push frame only; endOfAudio() must NOT be called per-frame —
      // it signals end of the entire speech turn. Call it explicitly
      // when SmartPBX sends a 'stop'/'hangup' event or silence detection fires.
      session.transport.audioInput.pushSmartPBXFrame(float32Array);
    }

  } catch (error) {
    console.error(`[${session.callId}] Error handling incoming audio:`, error);
  }
}

function sendAudioToSmartPBX(ws: WebSocket, session: SmartPBXSession, float32Array: Float32Array) {
  if (!session.mediaFormat || !session.isActive) {
    return;
  }

  try {
    const pcm16 = new Int16Array(float32Array.length);
    for (let i = 0; i < float32Array.length; i++) {
      const sample = Math.max(-1, Math.min(1, float32Array[i]));
      pcm16[i] = sample * 0x7FFF;
    }
    const pcmBase64 = Buffer.from(pcm16.buffer).toString('base64');

    let outgoingPayload: string;
    const targetSampleRate = parseInt(session.mediaFormat.sampleRate, 10);

    switch (session.conversionType) {
      case 'passthrough':
        outgoingPayload = pcmBase64;
        break;

      case 'resample':
        outgoingPayload = resamplePCM(pcmBase64, ARRIAFLOW_SAMPLE_RATE, targetSampleRate);
        break;

      case 'g711_mulaw':
        const pcmTargetRate = resamplePCM(pcmBase64, ARRIAFLOW_SAMPLE_RATE, targetSampleRate);
        outgoingPayload = pcmToMulaw(pcmTargetRate, targetSampleRate);
        break;

      case 'opus_decode':
        const pcmBuffer = Buffer.from(pcmBase64, 'base64');
        if (targetSampleRate !== ARRIAFLOW_SAMPLE_RATE) {
          const resampled = resamplePCM(pcmBase64, ARRIAFLOW_SAMPLE_RATE, targetSampleRate);
          const encoded = encodeOpus(Buffer.from(resampled, 'base64'));
          if (!encoded) return;
          outgoingPayload = encoded;
        } else {
          const encoded = encodeOpus(pcmBuffer);
          if (!encoded) return;
          outgoingPayload = encoded;
        }
        break;

      default:
        console.warn(`[${session.callId}] Unknown conversion type`);
        return;
    }

    const message = {
      event: 'media',
      callId: session.callId,
      accountId: session.accountId,
      media: { payload: outgoingPayload },
    };

    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
      session.hasSpoken = true;
    }

  } catch (error) {
    console.error(`[${session.callId}] Error sending audio:`, error);
  }
}

function sendError(ws: WebSocket, message: string) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      event: 'error',
      error: message,
    }));
  }
}

function handleDTMF(ws: WebSocket, session: SmartPBXSession, dtmf: any) {
  console.log(`[${session.callId}] DTMF pressed: ${dtmf.digit}`);

  if (session.voiceSession) {
    const dtmfText = `[DTMF: ${dtmf.digit}]`;
    session.voiceSession.generateReply({ userInput: dtmfText });
  }
}

// ============================================================================
// Start Server
// ============================================================================

console.log('');
console.log('╔════════════════════════════════════════════════════════════════════════════╗');
console.log('║         SmartPBX Bridge for Kuralle Voice Agents v2.0                     ║');
console.log('║                    (Powered by Hono)                                          ║');
console.log('╚════════════════════════════════════════════════════════════════════════════╝');
console.log('');
console.log(`Server running on:`);
console.log(`  HTTP:     http://${HOST}:${PORT}/`);
console.log(`  WebSocket: wss://${HOST}:${PORT}${WS_PATH}`);
console.log(`  Health:   http://${HOST}:${PORT}/health`);
console.log('');
console.log('📊 Audio Format Priority (Best to Worst):');
console.log(`  1. ✅ PASSTHROUGH: 24kHz PCM16 → 0ms (optimal!)`);
console.log(`  2. ⚡ RESAMPLE: 8kHz PCM16 → ~1-2ms`);
console.log(`  3. 🔧 G.711 μ-law → ~2-4ms`);
const opusAvailable = loadOpusCodec();
if (opusAvailable) {
  console.log(`  4. 🔄 Opus decode → ~5-10ms`);
} else {
  console.log(`  4. ❌ Opus decode → NOT AVAILABLE`);
}
console.log('');
console.log('⭐ RECOMMENDED SmartPBX Configuration:');
console.log(`     Encoding: PCM16`);
console.log(`     Sample Rate: 24000 Hz`);
console.log(`     Reason: Enables zero-conversion passthrough mode`);
console.log('');
console.log('📝 Available Tools:');
Object.entries(tools).forEach(([name]) => {
  console.log(`  • ${name}`);
});
console.log('');

process.on('SIGINT', async () => {
  console.log('');
  console.log('Shutting down...');

  for (const [id, session] of activeSessions) {
    if (session.voiceSession) {
      await session.voiceSession.close();
    }
  }
  activeSessions.clear();

  httpServer.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
