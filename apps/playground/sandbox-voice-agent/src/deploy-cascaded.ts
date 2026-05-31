#!/usr/bin/env npx tsx
/**
 * Deploy cascaded pipeline (Deepgram STT → Gemini Flash → Cartesia TTS)
 * inside a Vercel Sandbox.
 *
 * Run from apps/playground/sandbox-voice-agent:
 *   npx tsx src/deploy-cascaded.ts
 */

import { Sandbox } from '@vercel/sandbox';
import { readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const currentDir = dirname(fileURLToPath(import.meta.url));
const projectDir = join(currentDir, '..');
const repoRoot = join(projectDir, '../../..');

const SNAPSHOT_CACHE_PATH = join(projectDir, '.sandbox-snapshot-cascaded.json');

function loadEnv(paths: string[]) {
  for (const p of paths) {
    try {
      const c = readFileSync(p, 'utf-8');
      for (const l of c.split('\n')) {
        const t = l.trim();
        if (!t || t.startsWith('#')) continue;
        const e = t.indexOf('=');
        if (e <= 0) continue;
        const k = t.slice(0, e).trim();
        let v = t.slice(e + 1).trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        if (!process.env[k]) process.env[k] = v;
      }
    } catch {}
  }
}

loadEnv([
  join(projectDir, '.env.local'),
  join(repoRoot, '.env'),
  join(repoRoot, 'apps/playground/livekit-starters/livekit-agent-starter/.env.local'),
]);

const googleKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? process.env.GOOGLE_API_KEY;
const livekitUrl = process.env.LIVEKIT_URL;
const livekitKey = process.env.LIVEKIT_API_KEY;
const livekitSecret = process.env.LIVEKIT_API_SECRET;

if (!googleKey) { console.error('No GOOGLE_GENERATIVE_AI_API_KEY'); process.exit(1); }
if (!livekitUrl || !livekitKey) { console.error('No LIVEKIT_URL/LIVEKIT_API_KEY — needed for Deepgram/Cartesia'); process.exit(1); }

const sandboxPackage = {
  name: 'kuralle-sandbox-cascaded',
  private: true,
  type: 'module',
  dependencies: {
    '@kuralle-agents/core': '0.9.6',
    '@kuralle-agents/livekit-plugin': '0.9.6',
    '@kuralle-agents/livekit-plugin-transport-ws': '0.9.6',
    '@ai-sdk/google': '^2.0.0',
    '@livekit/agents': '^1.2.6',
    ai: '^6.0.0',
    ws: '^8.19.0',
    zod: '^3.23.0',
  },
};

const serverCode = `
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { initializeLogger, inference } from '@livekit/agents';
import { google } from '@ai-sdk/google';
import { createRuntime } from '@kuralle-agents/core';
import { defineAgent } from '@kuralle-agents/core';
import { tool } from 'ai';
import { z } from 'zod';
import { KuralleVoiceSession } from '@kuralle-agents/livekit-plugin';
import { WebSocketAgentServer } from '@kuralle-agents/livekit-plugin-transport-ws';

initializeLogger({ pretty: true, level: 'warn' });

const weatherTool = tool({
        description: 'Check weather for a city',
        inputSchema: z.object({ city: z.string() }),
        execute: async ({ city }) => {
          console.log('[tool] check_weather(' + city + ')');
          return { city, temp: 22, condition: 'partly cloudy' };
        },
      });

const assistant = defineAgent({
  id: 'assistant',
  name: 'Cascaded Agent',
  model: google('gemini-2.0-flash'),
  instructions: 'You are a friendly voice assistant. Keep responses to 1-2 sentences. Use check_weather when asked about weather.',
  tools: { check_weather: weatherTool },
  effectTools: {},
  knowledge: {},
});

const runtime = createRuntime({
  agents: [assistant],
  defaultAgentId: 'assistant',
  defaultModel: google('gemini-2.0-flash'),
  voiceMode: true,
});

const server = new WebSocketAgentServer({
  port: 3000,
  host: '0.0.0.0',
  defaultSampleRate: 24000,
  defaultNumChannels: 1,
});

server.onConnection(async (transport) => {
  console.log('[ws] cascaded connection: ' + transport.id);

  const stt = new inference.STT({ model: 'deepgram/nova-3', language: 'multi' });
  const tts = new inference.TTS({ model: 'cartesia/sonic-3', voice: '9626c31c-bec5-4cca-baa8-f8ba9e84c8bc' });

  const voiceSession = new KuralleVoiceSession({ runtime, stt, tts, greeting: null });
  await server.startSession(transport, voiceSession);
  console.log('[ws] cascaded session started: ' + transport.id);
});

await server.listen();
console.log('Cascaded (Deepgram → Gemini Flash → Cartesia) on port 3000');
`;

async function main() {
  console.log('Kuralle Cascaded Pipeline → Vercel Sandbox');
  console.log('Pipeline: Deepgram Nova-3 → Gemini Flash → Cartesia Sonic-3\n');

  const depSig = createHash('sha256').update(JSON.stringify(sandboxPackage.dependencies)).digest('hex');
  let snapshotId: string | undefined;

  // Check cached snapshot
  try {
    const cached = JSON.parse(readFileSync(SNAPSHOT_CACHE_PATH, 'utf-8'));
    if (cached.dependencySignature === depSig) {
      snapshotId = cached.snapshotId;
      console.log(`Using cached snapshot: ${snapshotId}`);
    }
  } catch {}

  // Create snapshot if needed
  if (!snapshotId) {
    console.log('Creating dependency snapshot (~60s)...');
    const setupSandbox = await Sandbox.create({ runtime: 'node24', ports: [3000], timeout: 300000 });
    try {
      await setupSandbox.writeFiles([
        { path: 'server.mjs', content: serverCode },
        { path: 'package.json', content: JSON.stringify(sandboxPackage, null, 2) },
      ]);
      const install = await setupSandbox.runCommand('npm', ['install', '--no-audit', '--no-fund']);
      if (install.exitCode !== 0) throw new Error('npm install failed');
      const snap = await setupSandbox.snapshot({ expiration: 0 });
      snapshotId = snap.snapshotId;
      writeFileSync(SNAPSHOT_CACHE_PATH, JSON.stringify({ snapshotId, dependencySignature: depSig, createdAt: new Date().toISOString() }));
      console.log(`Snapshot created: ${snapshotId}`);
    } finally {
      await setupSandbox.stop();
    }
  }

  // Create runtime sandbox
  const sandbox = await Sandbox.create({
    source: snapshotId ? { type: 'snapshot' as const, snapshotId } : undefined,
    runtime: snapshotId ? undefined : ('node24' as any),
    ports: [3000],
    timeout: 600000,
    env: {
      GOOGLE_API_KEY: googleKey!,
      GOOGLE_GENERATIVE_AI_API_KEY: googleKey!,
      LIVEKIT_URL: livekitUrl!,
      LIVEKIT_API_KEY: livekitKey!,
      LIVEKIT_API_SECRET: livekitSecret ?? '',
    },
  });

  const httpUrl = sandbox.domain(3000);
  const wsUrl = httpUrl.replace('https://', 'wss://');
  console.log(`Sandbox: ${sandbox.sandboxId}`);
  console.log(`URL: ${wsUrl}\n`);

  try {
    // Write fresh server code (snapshot has deps, may have stale server)
    await sandbox.writeFiles([
      { path: 'server.mjs', content: serverCode },
      { path: 'package.json', content: JSON.stringify(sandboxPackage, null, 2) },
    ]);

    if (!snapshotId) {
      console.log('Installing deps...');
      await sandbox.runCommand('npm', ['install', '--no-audit', '--no-fund']);
    }

    // Start server
    console.log('Starting cascaded server...');
    await sandbox.runCommand({ cmd: 'node', args: ['server.mjs'], detached: true });

    // Wait for ready
    console.log('Waiting for server...');
    for (let i = 0; i < 30; i++) {
      await sleep(1000);
      try {
        const resp = await fetch(httpUrl);
        if (resp.status === 101 || resp.status === 200 || resp.status === 426) {
          console.log(`Server ready (HTTP ${resp.status})\n`);
          break;
        }
      } catch {}
    }

    // Test
    console.log('Testing 3-turn conversation...');
    const pcmFiles = ['bench_hello.pcm', 'bench_weather.pcm', 'bench_goodbye.pcm'];
    const ws = new WebSocket(wsUrl);
    let totalAudio = 0;
    let turnAudio = 0;
    let turnsDone = 0;

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { ws.close(); reject(new Error('Test timeout')); }, 120000);

      ws.on('message', (d: Buffer, b: boolean) => {
        if (b) { totalAudio++; turnAudio++; }
        else {
          try {
            const m = JSON.parse(d.toString());
            if (m.type === 'session_started') {
              console.log('session_started');
              setTimeout(() => sendTurn(0), 5000);
            } else if (m.type === 'agent_text' && m.text) {
              console.log(`  agent: ${(m.text as string).slice(0, 80)}`);
            }
          } catch {}
        }
      });

      async function sendTurn(i: number) {
        if (i >= 3) {
          clearTimeout(timeout);
          console.log(`\nAll turns sent. Audio: ${totalAudio} chunks`);
          await sleep(5000); // drain
          console.log(`Final audio: ${totalAudio} chunks`);
          ws.close();
          resolve();
          return;
        }
        turnAudio = 0;
        const pcm = readFileSync(join(repoRoot, 'packages/kuralle-e2e-tests/fixtures', pcmFiles[i]));
        console.log(`\n--- Turn ${i + 1} ---`);
        for (let o = 0; o + 960 <= pcm.length; o += 960) {
          ws.send(pcm.subarray(o, o + 960));
          await sleep(40);
        }
        for (let j = 0; j < 100; j++) { ws.send(Buffer.alloc(960)); await sleep(20); }
        console.log('  sent');
        // Wait for audio response
        const w = Date.now();
        const ck = setInterval(() => {
          if (turnAudio > 0 && Date.now() - w > 8000) {
            clearInterval(ck);
            turnsDone++;
            console.log(`  turn ${i + 1}: ${turnAudio} chunks`);
            setTimeout(() => sendTurn(i + 1), 1500);
          } else if (Date.now() - w > 30000) {
            clearInterval(ck);
            console.log(`  turn ${i + 1}: timeout (${turnAudio} chunks)`);
            setTimeout(() => sendTurn(i + 1), 1000);
          }
        }, 200);
      }

      ws.on('error', (e: Error) => { clearTimeout(timeout); reject(e); });
    });

    console.log('\n═══════════════════════════════════════');
    console.log(`  Cascaded on Vercel Sandbox: ${totalAudio > 0 ? 'PASS' : 'FAIL'}`);
    console.log(`  Audio: ${totalAudio} chunks`);
    console.log(`  Pipeline: Deepgram → Gemini Flash → Cartesia`);
    console.log('═══════════════════════════════════════');

  } finally {
    console.log('\nStopping sandbox...');
    await sandbox.stop();
    console.log('Done');
  }
}

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
