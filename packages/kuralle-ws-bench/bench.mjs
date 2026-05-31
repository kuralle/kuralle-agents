#!/usr/bin/env node
/**
 * Orchestrator: spawn each server, run the load client against it, kill it,
 * move to the next. Prints summary lines for both at the end.
 */

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const CONFIGS = [
  { name: 'ws (Node ws@8)', server: 'servers/ws-server.mjs', port: 9001 },
  { name: 'sockudo (@sockudo/ws@1.6)', server: 'servers/sockudo-server.mjs', port: 9002 },
];

const CONCURRENCY = Number(process.env.CONCURRENCY ?? 10);
const FRAMES_PER_CALL = Number(process.env.FRAMES_PER_CALL ?? 250);

async function runOne(cfg) {
  console.log(`\n──────── starting ${cfg.name} ────────`);
  const env = { ...process.env, PORT: String(cfg.port) };
  const srv = spawn('node', [join(__dirname, cfg.server)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let serverReady = false;
  srv.stdout.on('data', (d) => {
    const line = d.toString().trim();
    if (line) console.log(`  ${line}`);
    if (line.includes('listening')) serverReady = true;
  });
  srv.stderr.on('data', (d) => {
    const line = d.toString().trim();
    if (line) console.log(`  STDERR: ${line}`);
  });

  // Wait for ready (max 10s)
  const t0 = performance.now();
  while (!serverReady && performance.now() - t0 < 10000) await sleep(50);
  if (!serverReady) {
    srv.kill('SIGKILL');
    throw new Error(`${cfg.name} did not become ready`);
  }
  await sleep(200); // small settle

  const url = `ws://127.0.0.1:${cfg.port}`;
  const client = spawn(
    'node',
    [join(__dirname, 'client/load-client.mjs'), url, cfg.name],
    {
      env: { ...process.env, CONCURRENCY: String(CONCURRENCY), FRAMES_PER_CALL: String(FRAMES_PER_CALL) },
      stdio: 'inherit',
    },
  );
  await new Promise((resolve, reject) => {
    client.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`client exited ${code}`))));
    client.on('error', reject);
  });

  srv.kill('SIGTERM');
  await sleep(300);
  if (!srv.killed) srv.kill('SIGKILL');
}

async function main() {
  console.log('Voice-frame WS server head-to-head');
  console.log(`Concurrency=${CONCURRENCY}  Frames/call=${FRAMES_PER_CALL}`);
  for (const cfg of CONFIGS) {
    try {
      await runOne(cfg);
    } catch (err) {
      console.log(`!! ${cfg.name} failed: ${err.message}`);
    }
  }
  console.log('\nDone.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
