# Transport Kitchen Sink Examples

This directory contains working examples for each transport type with a simple customer support agent.

## Examples

| Transport | File | Port | Protocol |
|-----------|------|------|----------|
| HTTP/SSE | `http-support/index.ts` | 3000 | HTTP + Server-Sent Events |
| WebSocket | `websocket-support/index.ts` | 8080 | WebSocket |
| WebSocket Text (Direct Runtime) | `websocket-audio-stream/index.ts` | 8080 | WebSocket (JSON, no voice pipeline) |
| Twilio | `twilio-support/index.ts` | 3000 | WebSocket (Twilio Media Streams) |
| SIP | `sip-support/index.ts` | 5060 | SIP/UDP + RTP |
| SmartPBX | `smartpbx-bridge/index.ts` | 8080 | WebSocket (SmartPBX telephony events) |
| **3CX** | `3cx-support/3cx-support.ts` | 5060 | SIP/UDP + RTP |

## Prerequisites

**All packages must be built first:**
```bash
cd packages/livekit-plugin-transport-http && bun run build
cd packages/livekit-plugin-transport-ws && bun run build
cd packages/livekit-plugin-transport-twilio && bun run build
cd packages/livekit-plugin-transport-sip && bun run build
cd packages/livekit-plugin && bun run build
```

Or build all from root:
```bash
bun run build
```

## Running

```bash
cd apps/playground/transport-examples
bun install

# Run examples
bun run http-support
bun run websocket-support
bun run twilio-support
bun run sip-support
```

## Customer Support Agent

All examples use the same simple customer support agent with:

### Agent Capabilities
- 🛎️ **Product Information**: Answer questions about plans and pricing
- 📦 **Order Lookup**: Check order status by order ID
- 🔄 **Returns & Exchanges**: Guide customers through return process
- 👥 **Human Transfer**: Escalate complex issues to human agents

### Available Plans
| Plan | Price | Features |
|------|-------|----------|
| Basic | $9.99/mo | 5 GB storage, Email support, Basic analytics |
| Pro | $29.99/mo | 100 GB storage, Priority support, Advanced analytics, API access |
| Enterprise | $99.99/mo | Unlimited storage, 24/7 phone support, Custom integrations |

### Tools Available
```typescript
- lookupOrder(orderId: string) - Get order status and tracking
- getProductInfo(planId: string) - Get plan details and pricing
- transferToHuman(reason: string) - Transfer to human agent
```

## Import Strategy

**We use `workspace:*` imports:**

```typescript
import { HTTPTransportAdapter } from '@kuralle/livekit-plugin-transport-http';
import { WebSocketTransportAdapter } from '@kuralle/livekit-plugin-transport-ws';
import { TwilioTransportAdapter } from '@kuralle/livekit-plugin-transport-twilio';
import { SIPAgentServer } from '@kuralle/livekit-plugin-transport-sip';
```

**How it works:**
1. Each transport package has its own `dist/` folder when built
2. `workspace:*` in `package.json` tells Bun how to resolve dependencies
3. TypeScript resolves `dist/index.js` and `dist/index.d.ts` for type checking
4. Everything just works - no pre-build scripts needed!

## Testing Each Transport

### HTTP/SSE
```bash
bun run http-support

# In another terminal:
# Start session
curl -X POST http://localhost:3000/session

# Stream audio
curl -X POST http://localhost:3000/session/{id}/audio --data-binary @audio.pcm
```

### WebSocket (Voice)
```bash
bun run websocket-support

# Connect with WebSocket client (binary PCM audio)
wscat -c ws://localhost:8080
```

### WebSocket (Text — Direct Runtime)
```bash
bun run websocket-audio-stream

# In another terminal:
bun run test-client

# Or use wscat:
wscat -c ws://localhost:8080/ws/my-session
# Then send: {"type":"user_text","text":"Hello!"}
```

This example calls `runtime.stream()` directly — no STT, TTS, VAD, or LiveKit dependencies.
It forwards all `HarnessStreamPart` events (text-delta, tool-call, tool-result, handoff, done, etc.)
straight to the WebSocket client.

### Twilio
```bash
bun run twilio-support

# Point Twilio TwiML to:
wss://your-domain.com/twilio/media

# Then call your Twilio number
```

### SIP
```bash
bun run sip-support

# Use a SIP softphone (Linphone, Zoiper, etc.)
# Address: 127.0.0.1:5060
# Transport: UDP
# Send INVITE to start call

### SmartPBX
```bash
bun run smartpbx-bridge

# SmartPBX Setup:
# 1. Create a SmartPBX account and trunk
# 2. Set WebSocket URL to: wss://your-domain.com/media-stream
# 3. Configure SbxML webhook to: http://your-domain.com/

# The server will return SbxML to connect the call
```

## Audio Requirements

## Opus Codec Support (Optional)

The SmartPBX bridge now supports Opus codec decoding/encoding (requires `opusscript`):

```bash
bun add opusscript
```

**Audio Format Priority:**
| Format | Latency | Notes |
|--------|---------|-------|
| **24kHz PCM16** | **0ms** | ✅ Passthrough - OPTIMAL! |
| 8kHz PCM16 | ~1-2ms | Lightweight resample |
| G.711 μ-law 8kHz | ~2-4ms | Telephony standard |
| Opus (any rate) | ~5-10ms | CPU intensive fallback |

**Recommendation:** Configure SmartPBX to send **PCM16 @ 24kHz** for zero-conversion passthrough mode!

| Transport | Sample Rate | Codec | Encoding |
|-----------|-------------|-------|----------|
| HTTP | 24kHz | PCM | Signed 16-bit LE |
| WebSocket | 24kHz | PCM | Signed 16-bit LE |
| WebSocket Text (Direct Runtime) | N/A | N/A | JSON text only |
| Twilio | 8kHz → 24kHz | G.711 μ-law | Base64 (auto-converted) |
| SIP | 8kHz → 24kHz | G.711 μ-law/A-law | RTP |
| SmartPBX | Any | PCM16, G.711 μ-law, Opus | Base64 (auto-converted) |

## Latency Analysis

### Conversion Pipeline

Audio format conversions are performed for telephony transports (Twilio, SIP, SmartPBX):

```
Phone (μ-law 8kHz) → WebSocket → [μ-law → PCM16 → 24kHz resample] → Kuralle Agent
                                                                    ↓
Phone (μ-law 8kHz) ← WebSocket ← [24kHz resample → PCM16 → μ-law] ← Response
```

### Conversion Latency Impact

| Factor | Impact | Notes |
|--------|--------|-------|
| **Codec conversion (μ-law ↔ PCM16)** | ~1-2ms | Pure computation, O(n) simple math |
| **Sample rate conversion (8kHz ↔ 24kHz)** | ~1-3ms | Linear interpolation, no buffering |
| **Total conversion overhead** | ~2-5ms | **Negligible** compared to other factors |

**Key insight:** The conversion itself adds minimal latency. The 8kHz source material already limits audio quality (Nyquist theorem: max 4kHz frequency). Upsampling to 24kHz doesn't add information—just spreads existing samples.

### End-to-End Round Trip Breakdown

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        COMPLETE ROUND TRIP LATENCY                          │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  1. PHONE → SMARTPBX                                                        │
│     Telephony network RTT:                              ~20-50ms             │
│                                                                             │
│  2. SMARTPBX → WEBSOCKET                                                     │
│     Internal WebSocket framing:                             ~10-20ms          │
│                                                                             │
│  3. INCOMING AUDIO CONVERSION                                               │
│     μ-law 8kHz → PCM16 24kHz:                               ~1-3ms            │
│                                                                             │
│  4. SPEECH-TO-TEXT (STT)                                                    │
│     Gemini Live streaming STT:                              ~50-150ms         │
│                                                                             │
│  5. LLM INFERENCE                                                           │
│     GPT-4o-mini response generation:                        ~100-400ms        │
│     (Can be interrupted for faster responses)                               │
│                                                                             │
│  6. TEXT-TO-SPEECH (TTS)                                                    │
│     Gemini TTS synthesis:                                   ~50-200ms         │
│                                                                             │
│  7. OUTGOING AUDIO CONVERSION                                               │
│     PCM16 24kHz → μ-law 8kHz:                               ~1-3ms            │
│                                                                             │
│  8. WEBSOCKET → SMARTPBX                                                    │
│     Internal WebSocket framing:                             ~10-20ms          │
│                                                                             │
│  9. SMARTPBX → PHONE                                                        │
│     Telephony network RTT:                                  ~20-50ms          │
│                                                                             │
├─────────────────────────────────────────────────────────────────────────────┤
│  TOTAL ESTIMATED LATENCY:                                  ~260-900ms        │
│  TYPICAL ROUND TRIP:                                        ~400ms           │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Latency Optimization Opportunities

If you need to reduce latency, here are the biggest wins (in order of impact):

1. **Interruptible responses** (~100-200ms savings)
   - Start speaking immediately, don't wait for full LLM response
   - Kuralle supports streaming TTS that can be interrupted

2. **Reduce chunk sizes** (~10-30ms savings)
   - Send audio frames more frequently (smaller chunks)
   - Trade-off: more network overhead

3. **Use faster models** (~50-150ms savings)
   - GPT-4o-mini is already fast, but consider specialized models
   - Example: `gpt-4.1-mini-turbo` for even faster inference

4. **Skip unnecessary upsampling** (~1-3ms savings)
   - Process at 16kHz instead of 24kHz
   - Minimal gain, not usually worth it

5. **Edge deployment** (~50-100ms savings)
   - Deploy closer to telephony provider
   - Reduces network RTT

**Bottom line:** Audio conversion adds ~2-5ms total—the least of your concerns. Focus on LLM/TTS optimization and network placement for meaningful latency improvements.

---


---

## 3CX Integration ✅

**Good news!** 3CX PBX integration is **already supported** via the existing SIP transport!

**How it works:**
1. Configure 3CX with a **SIP Trunk** pointing to your Kuralle server
2. Use the existing `sip-support.ts` example - no code changes needed!
3. Kuralle SIP server receives calls from 3CX and routes to your AI agent

**3CX Setup:**
- 3CX Admin Console → Voice & Chat → + Add Trunk
- Select "Generic SIP Trunk (IP Based)"
- Enter your Kuralle server IP and port 5060
- Create Inbound Rules to route DIDs to this trunk

**Quick start:**
\`\`\`bash
bun run sip-support
# Then configure 3CX to send calls to your server's IP:5060
\`\`\`

**Documentation:**
- \`docs/3CX_INTEGRATION_SIMPLIFIED.md\` - Complete guide
- \`docs/3CX_INTEGRATION_ANALYSIS.md\` - Detailed analysis (includes initial research)

**Note:** The initial research focused on 3CX Call Control API (for programmatic call management), but voice agents should use **SIP trunking** instead!

---

## Other Call Center Providers Research

**Comprehensive analysis of call center and communication providers** for voice AI agent integration.

| Provider | Kuralle Support | Integration Method | Effort |
|----------|-----------------|-------------------|--------|
| **Twilio** | ✅ Complete | Media Streams WebSocket | Done |
| **3CX** | ✅ Complete | SIP Trunking (via SIP package) | Done |
| **SmartPBX** | ✅ Complete | WebSocket telephony | Done |
| **Vonage** | ⚠️ Possible | WebSocket Voice API | 1-2 weeks |
| **RingCentral** | ⚠️ Possible | WebRTC WebPhone / SIP | 1-2 weeks |
| **Bandwidth** | ⚠️ Possible | SIP Trunking / Voice API | 1-2 weeks |
| **Telnyx** | ⚠️ Possible | SIP Trunking / WebSocket | 1-2 weeks |
| **Plivo** | ⚠️ Possible | SIP Trunking / REST API | 1-2 weeks |
| **SignalWire** | ⚠️ Possible | WebSocket / SIP | 1-2 weeks |
| **Genesys** | ❌ Enterprise | Proprietary integration | 2-4 weeks |
| **Five9** | ❌ Enterprise | Proprietary integration | 2-4 weeks |
| **Amazon Connect** | ❌ Enterprise | AWS-specific integration | 2-4 weeks |

**Full analysis**: See [`docs/CALL_CENTER_PROVIDERS_RESEARCH.md`](docs/CALL_CENTER_PROVIDERS_RESEARCH.md)

**Summary**: The top 3 providers for new integrations are **Vonage**, **Telnyx**, and **SignalWire** - all similar to Twilio with WebSocket-based Voice APIs that can reuse the existing Twilio transport pattern.
