#!/usr/bin/env node
/**
 * Realistic Twilio/voice load against either bench server.
 *
 * Each "call" is a long-lived WS that sends voice-sized binary frames at
 * the rate Twilio Media Streams uses (~50 frames/sec, 20ms apart).
 *
 * For each frame sent we record:
 *   - t_send         (ns) — local nanosecond timestamp before ws.send()
 *   - t_recv         (ns) — local nanosecond timestamp on receiving the echo
 *   - rtt_ns         = t_recv - t_send
 *   - server_ts_ms   parsed from the first 8 bytes of the echoed frame
 *
 * Latency reported: full client→server→client RTT (rtt_ns), and the
 * "server-side processing + uplink" leg (server_ts_ms - client_t_send_ms)
 * for completeness.
 *
 * Prints throughput, p50/p95/p99 RTT for each server.
 */

import WebSocket from 'ws';
import { performance } from 'node:perf_hooks';

const URL = process.argv[2] ?? 'ws://127.0.0.1:9001';
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 10);
const FRAMES_PER_CALL = Number(process.env.FRAMES_PER_CALL ?? 250); // 5 seconds @ 50fps
const FRAME_BYTES = Number(process.env.FRAME_BYTES ?? 320); // ~ Twilio μ-law 20ms frame
const FRAME_INTERVAL_MS = Number(process.env.FRAME_INTERVAL_MS ?? 20); // 50fps
const WARMUP_FRAMES = Number(process.env.WARMUP_FRAMES ?? 10); // exclude first N frames per call
const LABEL = process.argv[3] ?? URL;

function quantile(sortedArr, q) {
  if (sortedArr.length === 0) return 0;
  const pos = (sortedArr.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sortedArr[base + 1] !== undefined) {
    return sortedArr[base] + rest * (sortedArr[base + 1] - sortedArr[base]);
  }
  return sortedArr[base];
}

const FRAME_PAYLOAD = Buffer.alloc(FRAME_BYTES);
for (let i = 0; i < FRAME_BYTES; i++) FRAME_PAYLOAD[i] = i & 0xff;

async function runCall(callId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const rttNsList = [];
    const inflight = new Map();
    let framesSent = 0;
    let framesEchoed = 0;
    let connectStart = performance.now();
    let connectOpen = 0;
    let firstFrameSentAt = 0;
    let lastFrameRecvAt = 0;
    let sessionStartedAt = 0;
    let timeoutHandle = null;

    const fail = (err) => {
      try { ws.terminate(); } catch {}
      if (timeoutHandle) clearTimeout(timeoutHandle);
      reject(err);
    };
    const finish = () => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      try { ws.close(); } catch {}
      resolve({
        callId,
        connectMs: connectOpen - connectStart,
        sessionStartedMs: sessionStartedAt - connectOpen,
        framesSent,
        framesEchoed,
        elapsedMs: lastFrameRecvAt - firstFrameSentAt,
        rttNsList,
      });
    };

    timeoutHandle = setTimeout(() => fail(new Error(`call ${callId} timeout`)), 60000);

    ws.binaryType = 'arraybuffer';
    ws.on('open', () => {
      connectOpen = performance.now();
    });

    ws.on('message', (data, isBinary) => {
      const tRecv = process.hrtime.bigint();
      if (isBinary) {
        const bytes = Buffer.from(data);
        // Echoed frame layout:
        //   [0..8]   server-receive timestamp (BigUint64BE), prepended by server
        //   [8..12]  callId (original frame[0..4])
        //   [16..20] seq    (original frame[8..12]) ← server stamp pushed it 8 bytes
        const seq = bytes.readUInt32BE(16);
        const sendNs = inflight.get(seq);
        if (sendNs !== undefined) {
          rttNsList.push(Number(tRecv - sendNs));
          inflight.delete(seq);
          framesEchoed++;
          lastFrameRecvAt = performance.now();
          if (framesEchoed === FRAMES_PER_CALL) {
            ws.send(JSON.stringify({ type: 'end_of_audio' }));
          }
        }
        return;
      }
      const txt = data.toString();
      try {
        const msg = JSON.parse(txt);
        if (msg.type === 'session_started') {
          sessionStartedAt = performance.now();
          // Start sending frames
          firstFrameSentAt = performance.now();
          let seq = 0;
          const interval = setInterval(() => {
            if (seq >= FRAMES_PER_CALL) {
              clearInterval(interval);
              return;
            }
            const frame = Buffer.alloc(FRAME_BYTES);
            frame.writeUInt32BE(callId, 0);
            frame.writeUInt32BE(seq, 8);
            // Random-ish payload after the header so compression can't cheat
            for (let i = 12; i < FRAME_BYTES; i++) frame[i] = (seq + i) & 0xff;
            const sendNs = process.hrtime.bigint();
            inflight.set(seq, sendNs);
            try {
              ws.send(frame, { binary: true });
              framesSent++;
            } catch {
              clearInterval(interval);
            }
            seq++;
          }, FRAME_INTERVAL_MS);
        } else if (msg.type === 'done') {
          finish();
        }
      } catch {
        // ignore non-JSON text
      }
    });

    ws.on('error', fail);
    ws.on('close', (code) => {
      // If we never finished, fail
      if (framesEchoed < FRAMES_PER_CALL && rttNsList.length > 0) {
        finish();
      } else if (framesEchoed === 0) {
        fail(new Error(`closed before any frames echoed (code=${code})`));
      }
    });
  });
}

async function main() {
  console.log(`\n=== ${LABEL} ===`);
  console.log(`URL: ${URL}`);
  console.log(`Concurrency=${CONCURRENCY}  Frames/call=${FRAMES_PER_CALL}  Frame=${FRAME_BYTES}B  Interval=${FRAME_INTERVAL_MS}ms`);
  console.log(`Warmup frames excluded per call: ${WARMUP_FRAMES}`);

  const t0 = performance.now();
  const results = await Promise.all(
    Array.from({ length: CONCURRENCY }, (_, i) => runCall(i + 1).catch((err) => ({ callId: i + 1, error: err.message }))),
  );
  const tElapsedMs = performance.now() - t0;
  const successes = results.filter((r) => !r.error);
  const failures = results.filter((r) => r.error);

  if (failures.length) {
    console.log(`Failures: ${failures.length}/${results.length}`);
    failures.slice(0, 3).forEach((f) => console.log(`  call ${f.callId}: ${f.error}`));
  }

  const allRttNs = [];
  let totalSent = 0, totalEchoed = 0;
  for (const r of successes) {
    totalSent += r.framesSent;
    totalEchoed += r.framesEchoed;
    // Skip first WARMUP_FRAMES from each call to drop connection-establishment noise
    allRttNs.push(...r.rttNsList.slice(WARMUP_FRAMES));
  }

  if (allRttNs.length === 0) {
    console.log('No echoed frames recorded.');
    return;
  }

  allRttNs.sort((a, b) => a - b);
  const rttUs = allRttNs.map((ns) => ns / 1000);
  const p50 = quantile(rttUs, 0.5);
  const p95 = quantile(rttUs, 0.95);
  const p99 = quantile(rttUs, 0.99);
  const mean = rttUs.reduce((s, v) => s + v, 0) / rttUs.length;
  const max = rttUs[rttUs.length - 1];

  const aggregateThroughput = (totalEchoed / tElapsedMs) * 1000; // frames/sec across all calls

  console.log(`Calls completed: ${successes.length}/${CONCURRENCY}`);
  console.log(`Frames sent / echoed: ${totalSent} / ${totalEchoed}`);
  console.log(`Aggregate throughput: ${aggregateThroughput.toFixed(0)} echoes/sec across all calls`);
  console.log(`RTT (excluding ${WARMUP_FRAMES * successes.length} warmup frames):`);
  console.log(`  mean=${mean.toFixed(1)}µs  p50=${p50.toFixed(1)}µs  p95=${p95.toFixed(1)}µs  p99=${p99.toFixed(1)}µs  max=${max.toFixed(1)}µs`);
  console.log(`  samples: ${rttUs.length}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
