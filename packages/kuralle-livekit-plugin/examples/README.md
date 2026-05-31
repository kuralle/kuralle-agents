# @kuralle/livekit-plugin Examples

Voice agent examples demonstrating Kuralle Runtime with LiveKit's voice infrastructure.

## Prerequisites

1. **Build the plugin** (from monorepo root):
   ```bash
   bun run build
   ```

2. **Environment variables** — set API keys for the models used:
   ```bash
   export OPENAI_API_KEY="sk-..."        # GPT-4o-mini (LLM)
   export GOOGLE_API_KEY="..."           # Gemini Live STT/TTS
   ```

3. **First run** downloads ONNX models (~8MB) from HuggingFace for turn detection. Subsequent runs use the cached files in `~/.cache/huggingface/hub/`.

## WebSocket Examples

These examples start a WebSocket server. Connect with any WebSocket client that sends binary PCM audio (24kHz, mono, signed 16-bit LE).

### basic_voice_agent.ts

Minimal voice agent with a weather tool and two-layer turn detection.

```bash
cd packages/kuralle-livekit-plugin
npx tsx examples/basic_voice_agent.ts
# → ws://localhost:8080
```

### multi_agent_handoff.ts

Router agent that delegates to a game agent and back, demonstrating Kuralle native handoff system.

```bash
npx tsx examples/multi_agent_handoff.ts
# → ws://localhost:8080
```

### restaurant_agent.ts

Four-agent restaurant system (greeter, reservation, takeaway, checkout) with per-agent tools and cross-agent handoffs.

```bash
npx tsx examples/restaurant_agent.ts
# → ws://localhost:8080
```

### turn_detection_demo.ts

Showcases the two-layer turn detection system with custom configuration. Demonstrates how VAD, EOU, and LLM markers can be enabled/disabled independently.

```bash
npx tsx examples/turn_detection_demo.ts
# → ws://localhost:8080
```

## LiveKit Room Examples

These examples run inside a LiveKit room (WebRTC). You need a LiveKit server and room credentials.

### livekit_room_agent.ts

Minimal room-based voice agent with turn detection.

```bash
npx tsx examples/livekit_room_agent.ts dev --log-level=debug
```

Then connect at [https://cloud.livekit.io/](https://cloud.livekit.io/) or via the LiveKit CLI.

### livekit_room_with_tools.ts

Room-based agent with weather and light control tools plus turn detection.

```bash
npx tsx examples/livekit_room_with_tools.ts dev --log-level=debug
```

## Testing WebSocket Examples

Use the test client from the transport examples:

```bash
cd apps/playground/transport-examples
npx tsx test-client/index.ts
```

Or connect with any WebSocket client (e.g. `websocat`):

```bash
# Text-only test (no audio)
websocat ws://localhost:8080
```

## Architecture

All examples follow the same pattern:

```
┌─────────────────────────────────────────────────┐
│  Server Startup                                 │
│                                                 │
│  1. Create Kuralle Runtime (agents, tools)     │
│  2. Start WebSocket server / LiveKit worker     │
└────────────────────┬────────────────────────────┘
                     │
         ┌───────────▼───────────┐
         │  Per Connection       │
         │                       │
         │  KuralleVoiceSession │
         │    ├─ STT             │
         │    ├─ TTS             │
         │    └─ LLM (Runtime)   │
         └───────────────────────┘
```

- **Runtime** is shared across all connections (stateless orchestrator)
- **KuralleVoiceSession** is created per connection with its own LLM adapter
- For custom turn detection, use LiveKit's official plugins (`@livekit/agents-plugin-silero`, `@livekit/agents-plugin-livekit`) directly in your application
