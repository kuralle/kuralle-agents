# @kuralle-agents/ws-bench

Head-to-head benchmark — Node `ws@8` vs `@sockudo/ws@1.6.10` under realistic voice-frame echo workload. Tests the proposition that swapping Kuralle WS server (currently Node `ws`-based, in `@kuralle-agents/livekit-plugin-transport-ws`) for sockudo would help latency under voice-agent load.

## Methodology

Both servers run the same observable protocol:
1. On WS open, send `{ "type": "session_started", "t": <ms> }`.
2. On each binary frame received, prepend an 8-byte BE millisecond timestamp (server-receive time) and echo it back.
3. On `{ "type": "end_of_audio" }`, send `{ "type": "done" }`.

The client (`client/load-client.mjs`) opens N concurrent connections, each sending `FRAMES_PER_CALL` synthetic frames at the Twilio Media Streams cadence (50 fps, 20 ms apart). Each frame carries a 4-byte sequence number and the client uses `process.hrtime.bigint()` to measure RTT per frame. The first 10 frames per call are excluded as warmup.

The orchestrator (`bench.mjs`) spawns each server, runs the client, kills the server, moves on.

## Run

```bash
# Default: 10 concurrent calls × 200 frames × 320 bytes
node bench.mjs

# Higher load (close to a Fly machine's likely shape)
CONCURRENCY=50 FRAMES_PER_CALL=200 FRAME_BYTES=960 node bench.mjs
```

## Results — Apple M-series, local loopback

### 10 concurrent × 200 frames × 320B (representative single-tester load)

| Server | mean | **p50** | p95 | p99 | max |
|---|---|---|---|---|---|
| `ws@8` | 533µs | **369µs** | 1490µs | 2998µs | 6874µs |
| `@sockudo/ws@1.6` | 1510µs | 1512µs | 2206µs | 4334µs | 7024µs |

`ws` wins p50 by **~4×**. Verdict at low concurrency: stick with `ws`.

### 50 concurrent × 200 frames × 960B (saturated voice-agent host)

| Server | mean | p50 | **p95** | **p99** | max |
|---|---|---|---|---|---|
| `ws@8` | 1003µs | **625µs** | 3482µs | 5695µs | 8744µs |
| `@sockudo/ws@1.6` | 1447µs | 1720µs | **2244µs** | **2609µs** | **4913µs** |

The picture **flips on the tail** at high concurrency: sockudo wins p95 / p99 / max by 35–54%. Reason: `ws` serializes work on the single Node event loop; sockudo has lock-free queues + a Tokio multi-threaded runtime.

For voice quality, **p99 matters more than p50** — a single 5 ms hiccup is an audible glitch. So sockudo could be worth it under load. For single-tester demos, `ws` is fine.

## Files

- `servers/ws-server.mjs` — reference echo server using Node `ws`.
- `servers/sockudo-server.mjs` — same protocol on `@sockudo/ws`.
- `client/load-client.mjs` — concurrent load client with hrtime RTT measurement.
- `bench.mjs` — orchestrator (spawns server, runs client, tears down, repeats).

## Gotchas in `@sockudo/ws@1.6.10`

If you adapt this code, watch out for two NAPI quirks the type definitions don't reveal:

1. **Connection-callback args are shuffled.** The TS signature says `(ws: WebSocket, info: ConnectionInfo) => void`, but at runtime the callback is invoked with `(null, [WebSocket, ConnectionInfo])`. We unwrap as `args[1][0]`.
2. **`Message` accessor is `asBuffer()`, not `asBinary()`.** `msg.isBinary` is the boolean flag, but the buffer accessor is named `asBuffer` (`asText` for text). The TypeScript decl makes `asBuffer` look optional but it's how you actually get the bytes.

Both are upstream issues; documenting here so the next person isn't stuck.

## Verdict

The `17% faster than alternatives` claim in sockudo's README does not hold for this workload (small frames, high frequency). What sockudo *does* deliver is **lower tail-latency variance under saturation**. If your Kuralle deployment serves a single concurrent voice call at a time, you save nothing — and probably regress p50. If you serve dozens of concurrent calls per box, the p99 win is real.

For the current Fly demo (single tester), keep `ws`. Revisit if we ever co-locate many concurrent voice calls on one box.
