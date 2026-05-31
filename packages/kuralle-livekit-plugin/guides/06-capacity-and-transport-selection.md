# Capacity and Transport Selection

## Purpose

This guide turns business traffic goals into concrete engineering decisions.

Scope:

- call volume from 10 calls/day to 3000 calls/day
- transport selection by use case and operational constraints
- capacity math, concurrency policy, and admission control

The goal is not maximum theoretical throughput. The goal is stable, predictable real-time voice quality under expected and burst traffic.

## Definitions

- `D`: calls per day
- `M`: average call duration in minutes
- `B`: fraction of daily calls occurring in the busiest hour (busy-hour factor)
- `C_busy`: estimated concurrent calls in busiest hour

Formula:

`C_busy = (D * B * M) / 60`

Then apply headroom:

`C_target = ceil(C_busy * safety_factor)`

Recommended safety factor:

- 1.5 for low risk environments
- 2.0 for customer-facing production where SLA matters

## Worked examples

Assume:

- `M = 4` minutes
- `B = 0.25` (25% of daily calls in busiest hour)
- safety factor = 2.0

### Example A: 10 calls/day

- `C_busy = (10 * 0.25 * 4) / 60 = 0.17`
- `C_target = 1`

Interpretation:

- one warm instance is enough
- prioritize simplicity over aggressive autoscaling complexity

### Example B: 300 calls/day

- `C_busy = (300 * 0.25 * 4) / 60 = 5`
- `C_target = 10`

Interpretation:

- split at least by transport edge if phone traffic exists
- implement admission control and per-transport limits

### Example C: 3000 calls/day

- `C_busy = (3000 * 0.25 * 4) / 60 = 50`
- `C_target = 100`

Interpretation:

- multiple worker instances and regional strategy required
- control/media split recommended
- soak tests are mandatory before release

If your calls average longer than 4 minutes, scale numbers up linearly.

## Transport selection matrix

### `@kuralle/livekit-plugin-transport-ws`

Use when:

- you control client applications
- you need lowest protocol overhead and full duplex

Pros:

- excellent real-time characteristics
- precise control over protocol events and backpressure

Risks:

- custom client protocol ownership burden

### `@kuralle/livekit-plugin-transport-http`

Use when:

- client environments prefer HTTP + SSE
- interaction style is turn-based or buffered audio posts

Pros:

- easier integration with existing web/backend stacks
- firewall/network-policy friendly

Risks:

- less natural for very low-latency streaming than raw WS

### `@kuralle/livekit-plugin-transport-twilio`

Use when:

- PSTN ingress is required quickly and reliably
- Twilio is already your telephony provider

Pros:

- operationally mature path for phone calls
- good ecosystem and webhook model

Risks:

- provider dependency and telephony costs
- codec/sample-rate adaptation overhead

### `@kuralle/livekit-plugin-transport-sip`

Use when:

- you need direct SIP trunk/PBX interoperability
- RTP-level telephony control is mandatory

Pros:

- direct SIP trunk integration path
- useful for enterprise PBX environments

Risks:

- stricter networking and media-plane requirements
- more operational complexity than Twilio WebSocket media ingress

### `@kuralle/livekit-plugin-transport-sip-jssip`

Use when:

- endpoint is SIP over WebSocket/WebRTC
- browser/WebRTC SIP semantics are needed

Pros:

- cleanly separated from RTP trunk assumptions

Risks:

- separate operational profile from RTP SIP; do not merge concerns

### `@kuralle/livekit-plugin-transport-smartpbx`

Use when:

- integrating with SmartPBX-style event envelopes
- you need reusable adapter behavior outside example apps

Pros:

- transport logic is package-level, testable, reusable

Risks:

- external PBX event contract drift requires strict fixtures/tests

## Recommended transport strategy by call volume

### Stage 1: 10 to 100 calls/day

Recommended:

- primary transport: WS or HTTP/SSE
- phone entry: Twilio only if needed
- one region, one warm instance

Do not add SIP RTP yet unless business-critical.

### Stage 2: 100 to 1000 calls/day

Recommended:

- split Twilio edge from WS/HTTP edge
- external session store required (Redis/Postgres)
- enforce per-transport concurrency budget

Start formal soak testing and admission control.

### Stage 3: 1000 to 3000 calls/day

Recommended:

- control-plane and media-plane split
- region-aware routing
- explicit queue limits and overload behavior
- transport-specific scale groups

Only enable SIP RTP in this stage if you have proven network readiness and test coverage for INVITE/ACK/BYE + RTP behavior under load.

## Capacity blueprint in code

```ts
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT_CALLS ?? 80);
const MAX_QUEUE = Number(process.env.MAX_QUEUE_CALLS ?? 40);

const admission = new AdmissionController({
  maxActive: MAX_CONCURRENT,
  maxQueued: MAX_QUEUE,
});

twilioServer.onCall(async (callId) => {
  const decision = admission.tryAdmit(callId);
  if (!decision.accepted) {
    await twilioServer.reject(callId, { reason: 'over_capacity' });
    return;
  }

  const voiceSession = new KuralleVoiceSession({ runtime, stt, tts, greeting: null });
  try {
    await twilioServer.startSession(callId, voiceSession);
  } finally {
    admission.release(callId);
  }
});
```

This pattern prevents silent quality collapse when volume spikes.

## Session store and concurrency policy

At low scale, in-memory behavior may look fine.
At production scale, it causes hidden coupling and restart loss.

Required for 3000/day planning:

- persistent `sessionStore` enabled
- session TTL policy
- store health checks and retry behavior
- clear session ownership per active transport ID

## Performance and quality guardrails

### Hard guardrails

- max active sessions per worker
- max output queue depth per session
- timeout on stalled downstream writes
- deterministic session close on transport disconnect

### Soft guardrails

- degrade non-essential features first (verbose tracing, optional enrichments)
- keep core speech path prioritized

## Test requirements for confidence at scale

### Unit and contract

- protocol fixtures for each transport
- session identity isolation tests
- teardown determinism tests

### Integration

- end-to-end call/session flow per transport
- concurrent calls with unique session IDs

### Soak

- long-running mixed traffic with periodic reconnects
- memory growth checks
- queue-pressure and backpressure checks

### Failure injection

- provider timeout simulation
- sudden disconnect mid-speech
- store transient unavailability

## Suggested SLO-style targets

These are practical starting points and should be tuned from real traffic:

- call setup success: >= 99.5%
- abnormal teardown rate: <= 0.5%
- p95 first-response latency: <= 2.5s
- p95 turn latency (steady state): <= 1.5s incremental

## Decision summary

If your target is "platform-like" behavior comparable to established voice products:

1. use WS/HTTP for product UI channels
2. use Twilio for most PSTN ingress unless SIP trunk requirements are explicit
3. keep SIP RTP as a dedicated, validated telephony lane
4. scale by active concurrent sessions, not daily volume alone
5. enforce admission control before quality degrades

This gives a realistic path from early usage to 3000 calls/day without rewriting the architecture later.
