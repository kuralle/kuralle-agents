# Twilio Transport Examples

Examples for running Kuralle voice agents with Twilio Media Streams.

## Quick Start

```bash
# Install dependencies
bun install

# Run the echo bot (simplest - echoes audio back)
bun run example:echo

# Run the standalone server (full agent with LiveKit)
bun run example:server

# Run the Hono server (works with Hono framework)
bun run example:hono
```

## Examples

### 1. Echo Bot (`echo_bot.ts`)

The simplest example - echoes back any audio received from Twilio.

**Use case**: Testing the transport layer without needing a full AI agent.

**Features**:
- Minimal dependencies (only `ws`)
- Receives G.711 μ-law audio from Twilio
- Echoes audio back with small delay
- Logs connection events

**Run**:
```bash
bun run example:echo
```

**Test**:
1. Start the server
2. Point Twilio to `wss://your-domain.com/twilio/echo`
3. Call your Twilio number
4. Speak - you should hear your voice echoed back

---

### 2. Standalone Server (`standalone_server.ts`)

A full WebSocket server that integrates with LiveKit agents.

**Use case**: Production-ready Node.js/Bun server for Twilio voice agents.

**Features**:
- Full LiveKit agent integration
- G.711 μ-law codec handling
- Automatic resampling (8kHz ↔ 24kHz)
- Session management
- Graceful shutdown

**Run**:
```bash
# Configure your environment variables
export OPENAI_API_KEY=sk-...
export DEEPGRAM_API_KEY=...

bun run example:server
```

**Twilio Setup**:
1. Create a TwiML Application in Twilio console
2. Set Voice URL to: `wss://your-domain.com/twilio/media`
3. Point your Twilio phone number to the TwiML Application

---

### 3. Hono Server (`hono_server.ts`)

Uses the Hono web framework for maximum portability.

**Use case**: Deploy to Node.js, Bun, Deno, or Cloudflare Workers.

**Features**:
- Hono framework (lightweight & fast)
- Works on multiple runtimes
- Health check endpoint
- SSE events endpoint for monitoring
- TwiML generation endpoint

**Run (Node.js/Bun)**:
```bash
bun run example:hono
```

**Run (Cloudflare Workers)**:
```bash
# Requires wrangler setup
npx wrangler dev
```

**Endpoints**:
- `GET /` - Server info
- `GET /health` - Health check
- `GET /twilio/twiml` - Returns TwiML for Twilio
- `WS /twilio/media` - WebSocket for Media Streams
- `GET /events` - SSE event stream (monitoring)

---

## Twilio Configuration

### Option 1: TwiML Bin (Quick Testing)

Create a TwiML Bin in your Twilio console:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://your-domain.com/twilio/media" />
  </Connect>
</Response>
```

### Option 2: TwiML Application (Production)

1. Go to Twilio Console → TwiML → TwiML Apps
2. Create a new TwiML Application
3. Set Voice Request URL to your server's health endpoint
4. Configure your phone numbers to use this TwiML App

### Local Testing with ngrok

For local development, expose your local server:

```bash
# Install ngrok
brew install ngrok  # macOS
# or download from https://ngrok.com

# Start your server
bun run example:echo

# In another terminal, start ngrok
ngrok http 8080

# Use the ngrok URL in your TwiML
# <Stream url="wss://abc123.ngrok.io/twilio/echo" />
```

---

## Audio Flow

```
┌─────────────┐         ┌──────────────┐         ┌─────────────┐
│   Twilio    │────────▶│   Transport  │────────▶│    Agent    │
│  (G.711)    │  8kHz   │   Adapter    │  24kHz  │  (LiveKit)  │
└─────────────┘ μ-law   └──────────────┘ PCM     └─────────────┘
      ▲                                    │
      │                                    ▼
      └────────────────────────────────────────
              Audio Response
```

1. Twilio sends G.711 μ-law audio at 8kHz
2. Transport decodes μ-law to PCM
3. Transport resamples to 24kHz for Kuralle
4. Agent processes audio and generates response
5. Response resampled to 8kHz and encoded to μ-law
6. Sent back to Twilio

---

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `PORT` | Server port (default: 8080) | No |
| `HOST` | Server host (default: 0.0.0.0) | No |
| `OPENAI_API_KEY` | OpenAI API key | For examples using OpenAI |
| `DEEPGRAM_API_KEY` | Deepgram API key | For examples using Deepgram |

---

## Troubleshooting

### Connection Refused

- Ensure server is running: `bun run example:echo`
- Check firewall settings
- Verify Twilio URL matches your server

### No Audio

- Check that `streamSid` is being captured
- Verify Twilio is sending `media` events
- Check browser console for WebSocket errors

### Poor Audio Quality

- G.711 μ-law is 8kHz - expect telephone quality
- For better quality, consider using Twilio's `<Gather>` with higher bandwidth
- Check network latency

---

## Disabled Examples

- `cloudflare_worker.ts.bak` - Cloudflare Workers example (disabled)
- `wrangler.toml.bak` - Cloudflare Workers config (disabled)

These are disabled because Cloudflare Workers support requires additional setup.
