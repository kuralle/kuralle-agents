<a href="https://livekit.io/">
  <img src="./.github/assets/livekit-mark.png" alt="LiveKit logo" width="100" height="100">
</a>

# Kuralle × LiveKit — Voice Agent Starter

A minimal starter for running a [Kuralle](https://github.com/kuralle/kuralle-agents) agent as a voice bot on [LiveKit Agents](https://github.com/livekit/agents-js) and [LiveKit Cloud](https://cloud.livekit.io/).

LiveKit handles the voice pipeline — speech-to-text, text-to-speech, turn detection, and the room connection. Kuralle is the brain: instructions, tools, flows, routing, and handoffs. They meet through `KuralleRuntimeLLMAdapter`, which plugs a Kuralle runtime in as LiveKit's LLM.

## Project layout

Two files are all you need:

- **`src/runtime.ts`** — the agent's brain. A Kuralle runtime (`defineAgent` + `createRuntime`). Edit this to change what the bot does, add tools, or attach a flow.
- **`src/main.ts`** — the LiveKit wiring: STT/TTS, turn detection, and the worker that connects to LiveKit. You rarely need to touch this.

## Setup

This project uses [pnpm](https://pnpm.io/).

```bash
pnpm install
```

Sign up for [LiveKit Cloud](https://cloud.livekit.io/), then copy `.env.example` to `.env.local` and fill in:

- `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` — your LiveKit project
- `OPENAI_API_KEY` — the model provider for the Kuralle agent (gpt-4o-mini by default)

You can load the LiveKit values automatically with the [LiveKit CLI](https://docs.livekit.io/home/cli/cli-setup):

```bash
lk cloud auth
lk app env -w -d .env.local
```

## Run locally

Download the models the voice pipeline needs (Silero VAD and the LiveKit turn detector) once:

```bash
pnpm run download-files
```

Then start the agent worker — it connects to LiveKit and waits for a participant to join:

```bash
pnpm run dev
```

Connect to it with any [LiveKit frontend starter](https://github.com/livekit-examples/agent-starter-react) (web, mobile, or telephony). For production, `pnpm run start` runs the same worker, and the included `Dockerfile` is ready for [deployment](https://docs.livekit.io/agents/ops/deployment/).

## License

MIT — see [LICENSE](LICENSE).
