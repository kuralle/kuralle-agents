#!/usr/bin/env npx tsx
/**
 * Deploy an Kuralle voice agent inside a Vercel Sandbox.
 *
 * 1. Creates a Node.js sandbox with port 8080 exposed
 * 2. Writes a minimal WS voice agent server
 * 3. Installs ws dependency, starts server (detached)
 * 4. Tests HTTP + WebSocket connectivity
 * 5. Prints public URLs for browser testing
 *
 * Run from the sandbox-voice-agent directory:
 *   npx tsx src/deploy-sandbox.ts
 */

import { Sandbox } from '@vercel/sandbox';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const currentDir = dirname(fileURLToPath(import.meta.url));
const projectDir = join(currentDir, '..');

// Load .env.local (Vercel OIDC) + root .env (Google API key)
for (const envFile of [join(projectDir, '.env.local'), join(projectDir, '../../../.env')]) {
  try {
    const content = readFileSync(envFile, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx > 0) {
        const key = trimmed.slice(0, eqIdx).trim();
        let val = trimmed.slice(eqIdx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (!process.env[key]) process.env[key] = val;
      }
    }
  } catch {}
}

const googleKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? process.env.GOOGLE_API_KEY;

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Kuralle Voice Agent → Vercel Sandbox');
  console.log('═══════════════════════════════════════════════════════════\n');

  // The server code that runs INSIDE the sandbox
  // Simple WS echo server first — prove connectivity before adding Gemini
  const serverCode = `
const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = 3000;
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', agent: 'kuralle-sandbox', uptime: process.uptime() }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Kuralle Voice Agent — connect via WebSocket');
});

const wss = new WebSocketServer({ server });
let connections = 0;

wss.on('connection', (ws) => {
  connections++;
  const connId = connections;
  console.log('[ws] client ' + connId + ' connected');

  ws.send(JSON.stringify({
    type: 'session_started',
    sessionId: 'sandbox-' + Date.now() + '-' + connId,
    agent: 'kuralle-sandbox',
  }));

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      // Echo binary audio back as proof of concept
      ws.send(data);
    } else {
      try {
        const msg = JSON.parse(data.toString());
        console.log('[ws] ' + connId + ' received: ' + msg.type);
        if (msg.type === 'user_text') {
          ws.send(JSON.stringify({ type: 'agent_text', text: 'Echo: ' + msg.text }));
        }
      } catch {}
    }
  });

  ws.on('close', () => console.log('[ws] client ' + connId + ' disconnected'));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('Kuralle sandbox agent listening on port ' + PORT);
});
`;

  // 1. Create sandbox
  console.log('Phase 1: Creating sandbox...');
  const t0 = Date.now();

  const sandbox = await Sandbox.create({
    runtime: 'node24',
    ports: [3000],
    timeout: 300000, // 5 minutes
  });

  const createMs = Date.now() - t0;
  console.log(`  Created in ${createMs}ms`);
  console.log(`  Sandbox ID: ${sandbox.sandboxId}`);

  const httpUrl = sandbox.domain(3000);
  const wsUrl = httpUrl.replace('https://', 'wss://');
  console.log(`  HTTP: ${httpUrl}`);
  console.log(`  WS:   ${wsUrl}\n`);

  try {
    // 2. Write server + install deps
    console.log('Phase 2: Writing server code...');
    // Create working directory first
    await sandbox.runCommand({ cmd: 'mkdir', args: ['-p', '/home/user/app'] });

    await sandbox.writeFiles([
      { path: 'server.js', content: serverCode },
      { path: 'package.json', content: JSON.stringify({
        name: 'kuralle-sandbox-agent',
        private: true,
        dependencies: { ws: '^8.19.0' },
      }) },
    ]);

    console.log('Phase 3: Installing dependencies...');
    const installResult = await sandbox.runCommand({
      cmd: 'npm',
      args: ['install'],
    });
    console.log(`  npm install: exit ${installResult.exitCode} (${Date.now() - t0 - createMs}ms)\n`);

    // 3. Start server
    console.log('Phase 4: Starting server...');
    await sandbox.runCommand({
      cmd: 'node',
      args: ['server.js'],
      detached: true,
    });

    console.log('  Server started (detached)');
    console.log('  Waiting 3s for startup...');
    await sleep(3000);

    // 4. Test HTTP
    console.log('\nPhase 5: Testing connectivity');
    let httpOk = false;
    try {
      const resp = await fetch(`${httpUrl}/health`);
      const health = await resp.json() as { status: string };
      console.log(`  HTTP /health: ${JSON.stringify(health)}`);
      httpOk = health.status === 'ok';
    } catch (err: any) {
      console.log(`  HTTP failed: ${err.message}`);
    }

    // 5. Test WebSocket
    let wsOk = false;
    let sessionId = '';

    const ws = new WebSocket(wsUrl);
    const wsResult = await new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => { ws.close(); resolve(false); }, 10000);

      ws.on('open', () => console.log('  WS connected'));
      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'session_started') {
            sessionId = msg.sessionId;
            console.log(`  WS session_started: ${sessionId}`);

            // Test text echo
            ws.send(JSON.stringify({ type: 'user_text', text: 'Hello from outside!' }));
          } else if (msg.type === 'agent_text') {
            console.log(`  WS agent_text: "${msg.text}"`);
            clearTimeout(timeout);
            ws.close();
            resolve(true);
          }
        } catch {}
      });
      ws.on('error', (err) => {
        console.log(`  WS error: ${err.message}`);
        clearTimeout(timeout);
        resolve(false);
      });
    });
    wsOk = wsResult;

    // 6. Report
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('  RESULTS');
    console.log('═══════════════════════════════════════════════════════════');
    console.log(`  Sandbox ID:     ${sandbox.sandboxId}`);
    console.log(`  Create time:    ${createMs}ms`);
    console.log(`  HTTP URL:       ${httpUrl}`);
    console.log(`  WebSocket URL:  ${wsUrl}`);
    console.log(`  HTTP health:    ${httpOk ? 'PASS' : 'FAIL'}`);
    console.log(`  WebSocket:      ${wsOk ? 'PASS — session_started + echo working' : 'FAIL'}`);
    console.log(`  Session ID:     ${sessionId}`);
    console.log(`\n  ${httpOk && wsOk ? 'SUCCESS — Voice agent sandbox is live!' : 'FAILED'}`);

    if (httpOk && wsOk) {
      console.log(`\n  To test in browser, open:`);
      console.log(`  packages/kuralle-e2e-tests/try-voice-agent/index.html`);
      console.log(`  and change the server URL to: ${wsUrl}`);
    }

  } finally {
    console.log('\nPhase 6: Stopping sandbox...');
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
