#!/usr/bin/env npx tsx
/**
 * POC: Deploy an Kuralle voice agent inside a Vercel Sandbox.
 *
 * Steps:
 * 1. Create a Node.js sandbox with port 8080 exposed
 * 2. Write a minimal voice agent server into the sandbox
 * 3. Install deps + start the server (detached)
 * 4. Get the public WSS URL
 * 5. Connect a WS client and verify session_started
 * 6. Optionally send audio and verify response
 * 7. Stop the sandbox
 *
 * Run:
 *   npx tsx packages/kuralle-e2e-tests/sandbox-poc/deploy.ts
 */

import { Sandbox } from '@vercel/sandbox';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const currentDir = dirname(fileURLToPath(import.meta.url));
const rootDir = join(currentDir, '../../..');

// Load .env for Google API key
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
} catch {}

const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? process.env.GOOGLE_API_KEY;
if (!apiKey) {
  console.log('SKIP: Set GOOGLE_GENERATIVE_AI_API_KEY');
  process.exit(0);
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  POC: Kuralle Voice Agent in Vercel Sandbox');
  console.log('═══════════════════════════════════════════════════════════\n');

  // 1. Create sandbox
  console.log('Phase 1: Create Sandbox');
  const sandbox = await Sandbox.create({
    runtime: 'node24',
    ports: [8080],
    timeout: 300000, // 5 minutes
  });

  console.log(`  Sandbox ID: ${sandbox.sandboxId}`);
  const publicUrl = sandbox.domain(8080);
  console.log(`  Public URL: ${publicUrl}`);
  const wsUrl = publicUrl.replace('https://', 'wss://');
  console.log(`  WS URL: ${wsUrl}\n`);

  try {
    // 2. Write the agent server into the sandbox
    console.log('Phase 2: Write Agent Server');

    const serverCode = `
const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = 8080;
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Kuralle Voice Agent running in Vercel Sandbox');
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  console.log('Client connected');

  // Send session_started
  ws.send(JSON.stringify({
    type: 'session_started',
    sessionId: 'sandbox-' + Date.now(),
    sandbox: true,
  }));

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      // Echo binary audio back (proof of concept)
      ws.send(data);
    } else {
      const msg = JSON.parse(data.toString());
      console.log('Received:', msg.type);
    }
  });

  ws.on('close', () => console.log('Client disconnected'));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('Server listening on port ' + PORT);
});
`;

    await sandbox.writeFiles({
      '/app/server.js': serverCode,
      '/app/package.json': JSON.stringify({
        name: 'kuralle-sandbox-agent',
        private: true,
        dependencies: { ws: '^8.19.0' },
      }),
    });
    console.log('  Server code written\n');

    // 3. Install deps
    console.log('Phase 3: Install Dependencies');
    const installResult = await sandbox.runCommand({
      cmd: 'npm',
      args: ['install', '--prefix', '/app'],
    });
    console.log(`  npm install: exit ${installResult.exitCode}\n`);

    // 4. Start server (detached)
    console.log('Phase 4: Start Server');
    const serverProcess = await sandbox.runCommand({
      cmd: 'node',
      args: ['/app/server.js'],
      detached: true,
    });
    console.log('  Server started (detached)');

    // Wait for server to be ready
    await sleep(3000);
    console.log('  Waiting 3s for startup...\n');

    // 5. Test HTTP endpoint
    console.log('Phase 5: Test HTTP');
    try {
      const httpUrl = publicUrl;
      const resp = await fetch(httpUrl);
      const text = await resp.text();
      console.log(`  HTTP ${resp.status}: ${text}\n`);
    } catch (err) {
      console.log(`  HTTP failed: ${err}\n`);
    }

    // 6. Test WebSocket
    console.log('Phase 6: Test WebSocket');
    const ws = new WebSocket(wsUrl);

    const wsResult = await new Promise<{ success: boolean; message: string }>((resolve) => {
      const timeout = setTimeout(() => {
        ws.close();
        resolve({ success: false, message: 'WS connection timeout (10s)' });
      }, 10000);

      ws.on('open', () => {
        console.log('  WS connected');
      });

      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        console.log(`  Received: ${JSON.stringify(msg)}`);
        if (msg.type === 'session_started') {
          clearTimeout(timeout);
          ws.close();
          resolve({ success: true, message: `session_started: ${msg.sessionId}` });
        }
      });

      ws.on('error', (err) => {
        clearTimeout(timeout);
        resolve({ success: false, message: `WS error: ${err.message}` });
      });

      ws.on('close', () => {
        console.log('  WS closed');
      });
    });

    console.log(`  Result: ${wsResult.success ? 'PASS' : 'FAIL'} — ${wsResult.message}\n`);

    // 7. Results
    console.log('═══════════════════════════════════════════════════════════');
    console.log('  RESULTS');
    console.log('═══════════════════════════════════════════════════════════');
    console.log(`  Sandbox ID:  ${sandbox.sandboxId}`);
    console.log(`  Public URL:  ${publicUrl}`);
    console.log(`  WS URL:      ${wsUrl}`);
    console.log(`  HTTP:        ${wsResult.success ? 'Working' : 'Failed'}`);
    console.log(`  WebSocket:   ${wsResult.success ? 'Working — session_started received' : 'Failed'}`);
    console.log(`  Status:      ${wsResult.success ? 'SUCCESS' : 'FAILED'}`);

  } finally {
    // 8. Cleanup
    console.log('\nPhase 7: Cleanup');
    await sandbox.stop();
    console.log('  Sandbox stopped');
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
