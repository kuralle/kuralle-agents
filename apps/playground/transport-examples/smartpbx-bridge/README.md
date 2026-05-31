# SmartPBX Bridge for Kuralle Voice Agents

A complete, production-ready WebSocket bridge that connects SmartPBX telephony systems to Kuralle voice agents with intelligent audio format detection and optimized conversion paths.

## 🚀 Features

- **✅ Zero-Conversion Passthrough** - 24kHz PCM16 audio flows through with ~0ms latency
- **⚡ Sample Rate Conversion** - Lightweight 8kHz ↔ 24kHz resampling (~1-2ms)
- **🔧 G.711 μ-law Support** - Full telephony standard codec support (~2-4ms)
- **🔄 Opus Codec** - Optional Opus decode/encode (~5-10ms, requires `opusscript`)
- **🎹 DTMF Support** - Handle touch-tone key presses
- **🔧 Tool Integration** - Customer support tools (order lookup, product info, transfer)
- **📊 Health Monitoring** - Built-in health check endpoint

## 📋 Table of Contents

- [Quick Start](#quick-start)
- [Audio Format Priority](#audio-format-priority)
- [Architecture](#architecture)
- [SmartPBX Configuration](#smartpbx-configuration)
- [Complete Call Flow](#complete-call-flow)
- [Tools](#tools)
- [Deployment](#deployment)
- [Troubleshooting](#troubleshooting)

## 🎯 Quick Start

### Prerequisites

```bash
# From the transport-examples directory
bun install
```

### Run the Server

```bash
# From the smartpbx-bridge directory
bun run index.ts
```

The server will start on:
- HTTP: `http://0.0.0.0:8080/`
- WebSocket: `wss://0.0.0.0:8080/media-stream`
- Health Check: `http://0.0.0.0:8080/health`

## 🎵 Audio Format Priority

The bridge automatically detects the SmartPBX audio format and chooses the optimal conversion path:

| Priority | Format | Latency | Use Case |
|----------|--------|---------|----------|
| **1. ✅** | **24kHz PCM16** | **~0ms** | **OPTIMAL! Configure SmartPBX for this** |
| **2. ⚡** | **8kHz PCM16** | ~1-2ms | Direct PCM from digital systems |
| **3. 🔧** | **G.711 μ-law 8kHz** | ~2-4ms | Traditional telephony |
| **4. 🔄** | **Opus (any rate)** | ~5-10ms | Fallback (CPU intensive) |

### Performance Comparison

```
Passthrough (24kHz PCM16):
  pcmData = payload;  // ← 1 assignment, ~0.001ms

Resample (8kHz PCM16):
  pcmData = resamplePCM(payload, 8000, 24000);  // ← ~1-2ms

G.711 μ-law (8kHz):
  pcmData = mulawToPcm(payload);  // ← ~1.5ms
  pcmData = resamplePCM(pcm, 24000);  // ← ~1.5ms
  Total: ~3ms

Opus decode:
  pcmData = opusDecoder.decode(opusData);  // ← ~5-10ms
```

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         COMPLETE CALL FLOW                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  1. PHONE → SMARTPBX                                                        │
│     Caller dials number                                                     │
│                                                                             │
│  2. SMARTPBX → BRIDGE WebSocket                                            │
│     { event: 'start',                                                       │
│       mediaFormat: { encoding: 'pcm16', sampleRate: '24000' } }            │
│                                                                             │
│  3. BRIDGE → Create KuralleVoiceSession                                   │
│     - Detect format: 24kHz PCM16 ✅                                        │
│     - Enable passthrough mode                                              │
│     - Start voice session with transport adapter                           │
│                                                                             │
│  4. PHONE SPEAKS → SMARTPBX → BRIDGE                                       │
│     { event: 'media', media: { payload: 'base64-pcm16' } }                 │
│     ↓                                                                       │
│     Passthrough: payload → Kuralle (0ms conversion)                       │
│     ↓                                                                       │
│     KuralleVoiceSession processes speech                                  │
│                                                                             │
│  5. KuralleVoiceSession → STT → LLM → TTS                                 │
│     - STT: "What's my order status?"                                       │
│     - LLM: Detects intent to use lookupOrder tool                          │
│     - Tool: lookupOrder('ORD-12345') → { status: 'shipped', ... }         │
│     - TTS: "Your order has been shipped! Tracking: 1Z999AA1"               │
│                                                                             │
│  6. KuralleVoiceSession → BRIDGE → SMARTPBX → PHONE                      │
│     Float32Array @ 24kHz → PCM16 base64 → Passthrough → Phone             │
│     ↓                                                                       │
│     Caller hears: "Your order has been shipped!"                           │
│                                                                             │
│  7. CALL END                                                                │
│     SmartPBX: { event: 'stop' }                                            │
│     Bridge: Close KuralleVoiceSession                                    │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## 📱 SmartPBX Configuration

### Recommended Configuration (Optimal)

Configure SmartPBX to send **PCM16 @ 24kHz** for zero-conversion passthrough:

```xml
<!-- SmartPBX Trunk Configuration -->
<Trunk>
  <WebSocket>
    <Url>wss://your-domain.com/media-stream</Url>
    <AudioEncoding>pcm16</AudioEncoding>
    <SampleRate>24000</SampleRate>
  </WebSocket>
</Trunk>
```

### SbxML Webhook Configuration

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://your-domain.com/media-stream" />
  </Connect>
</Response>
```

Point your SmartPBX webhook to: `http://your-domain.com/`

## 🔄 Complete Call Flow

### Phase 1: Connection

```typescript
SmartPBX: → WebSocket CONNECT
Bridge:  ← "Connected! [sessionId: abc-123]"
```

### Phase 2: Call Start

```typescript
SmartPBX: → {
  event: 'start',
  start: {
    callId: 'call-456',
    mediaFormat: { encoding: 'pcm16', sampleRate: '24000' }
  }
}

Bridge:  → ✅ PASSTHROUGH MODE: 24kHz PCM16 (zero conversion!)
Bridge:  → Starting KuralleVoiceSession...
Bridge:  → ✅ Voice session started!
```

### Phase 3: User Speaks

```typescript
SmartPBX: → { event: 'media', media: { payload: 'ABC123...' } }

Bridge:  → ✅ PASSTHROUGH (0ms)
Bridge:  → pcmData = 'ABC123...'  // Direct assignment, no conversion!
Bridge:  → Float32Array → Kuralle STT
```

### Phase 4: Agent Responds

```typescript
Kuralle: → [Processes speech, generates response]
Kuralle: → Float32Array [TTS audio]

Bridge:  → Int16Array → PCM16 base64
Bridge:  → ✅ PASSTHROUGH (0ms)
Bridge:  → { event: 'media', media: { payload: 'XYZ789...' } }
SmartPBX: ← [Plays audio to caller]
```

### Phase 5: Call End

```typescript
SmartPBX: → { event: 'stop' }
Bridge:  → Closing voice session...
Bridge:  ← WebSocket CLOSE
```

## 🛠️ Tools

The agent comes with built-in tools for customer support:

### lookupOrder

Look up order status by ID.

```typescript
Agent: "Can you check order ORD-12345?"
Tool:  lookupOrder('ORD-12345')
→ {
    found: true,
    status: 'shipped',
    tracking: '1Z999AA1',
    items: [{ name: 'Wireless Headphones', quantity: 1 }],
    message: "Order ORD-12345 is shipped. Tracking: 1Z999AA1"
  }
Agent: "Your order has been shipped! Tracking number is 1Z999AA1."
```

### getProductInfo

Get information about products/plans.

```typescript
Agent: "Tell me about the premium plan"
Tool:  getProductInfo('premium-plan')
→ {
    name: 'Premium Plan',
    price: 29.99,
    description: '100 GB storage, priority support, advanced analytics',
    inStock: true
  }
```

### transferToHuman

Transfer call to human agent.

```typescript
Agent: "I'll transfer you to a specialist"
Tool:  transferToHuman('complex billing issue')
→ {
    transferred: true,
    ticketNumber: 'TKT-1234567890',
    estimatedWaitTime: '2 minutes'
  }
```

### checkBalance

Check account balance.

```typescript
Agent: "Your current balance is $150.00"
Tool:  checkBalance('acct-123')
→ {
    balance: 150,
    currency: 'USD',
    nextBillingDate: '2024-02-01'
  }
```

### updateAccount

Update account information.

```typescript
Agent: "I've updated your email address"
Tool:  updateAccount('acct-123', { email: 'new@email.com' })
→ {
    updated: true,
    fields: ['email']
  }
```

## 🚀 Deployment

### Local Development

```bash
# Run locally
bun run index.ts

# Test with curl
curl http://localhost:8080/health
```

### Railway / Render

```bash
# Deploy to Railway
railway up

# Or use the Railway CLI
railway init
railway add
railway deploy
```

### Docker

```dockerfile
FROM oven/bun:1

WORKDIR /app
COPY package.json bun.lockb ./
COPY . .

RUN bun install

EXPOSE 8080

CMD ["bun", "run", "index.ts"]
```

### Environment Variables

```bash
# Server
PORT=8080
HOST=0.0.0.0

# Optional: Opus codec (install if needed)
# bun add opusscript
```

## 🔧 Troubleshooting

### Audio Not Working

1. **Check SmartPBX configuration**
   ```bash
   curl http://localhost:8080/health
   ```

2. **Verify WebSocket connection**
   - Check server logs for "SmartPBX connected" message
   - Ensure WebSocket URL is correct: `wss://your-domain.com/media-stream`

3. **Test media format detection**
   ```bash
   # Look for these log messages:
   ✅ PASSTHROUGH MODE: 24kHz PCM16 (zero conversion!)
   ⚡ RESAMPLE MODE: PCM16 8kHz → 24kHz
   🔧 G.711 μ-law MODE: 8kHz → PCM16 24kHz
   🔄 OPUS MODE: 16kHz → PCM16 24kHz
   ```

### Opus Codec Not Available

If you see `⚠️ Opus codec not available`, install opusscript:

```bash
bun add opusscript
```

### High Latency

1. **Configure SmartPBX for 24kHz PCM16** (eliminates conversion overhead)
2. Check network RTT to SmartPBX servers
3. Use faster LLM models (gpt-4o-mini is already optimized)
4. Consider edge deployment closer to SmartPBX

## 📊 Monitoring

### Health Check

```bash
curl http://localhost:8080/health
```

Response:
```json
{
  "status": "OK",
  "timestamp": "2024-01-20T12:00:00.000Z",
  "websocket_endpoint": "wss://localhost:8080/media-stream",
  "opus_codec_available": true,
  "supported_formats": [
    "PCM16 @ 24kHz (passthrough - optimal)",
    "PCM16 @ 8kHz (resample)",
    "G.711 μ-law @ 8kHz (convert)",
    "Opus (decode/encode)"
  ],
  "recommended_config": {
    "encoding": "pcm16",
    "sampleRate": "24000",
    "reason": "Enables zero-conversion passthrough mode"
  }
}
```

## 📝 API Reference

### WebSocket Events

#### SmartPBX → Bridge

**start** - Call started
```json
{
  "event": "start",
  "start": {
    "callId": "call-123",
    "accountId": "account-456",
    "callerIdNumber": "+15551234567",
    "calleeIdNumber": "+15559876543",
    "mediaFormat": {
      "encoding": "pcm16",
      "sampleRate": "24000"
    }
  }
}
```

**media** - Audio data
```json
{
  "event": "media",
  "media": {
    "payload": "base64-encoded-audio-data"
  }
}
```

**stop** - Call ended
```json
{
  "event": "stop"
}
```

**dtmf** - DTMF key press
```json
{
  "event": "dtmf",
  "dtmf": {
    "digit": "1"
  }
}
```

#### Bridge → SmartPBX

**media** - Agent audio
```json
{
  "event": "media",
  "callId": "call-123",
  "accountId": "account-456",
  "media": {
    "payload": "base64-encoded-audio-data"
  }
}
```

The official SmartPBX AI Provider document does not define a `mark` event. Production integrations should use `start`, `media`, and WebSocket close as the normative protocol surface.

## 📄 License

MIT

## 🤝 Contributing

Contributions welcome! Please open an issue or submit a pull request.
