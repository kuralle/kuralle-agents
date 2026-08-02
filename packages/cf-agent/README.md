# @kuralle-agents/cf-agent

Run Kuralle agents on Cloudflare Workers using Durable Objects — CF owns persistence, WebSocket, and stream resumability; Kuralle owns agent orchestration.

## Install

```bash
npm install @kuralle-agents/cf-agent
```

Peers: `agents` (Cloudflare Agents SDK), `zod`.

## What it does

`KuralleAgent` extends CF's `AIChatAgent`. Subclass it, implement two methods, and your Kuralle agent runs as a Durable Object with automatic SQLite persistence, multi-client sync, and resumable streaming.

**Key exports:**

- **`KuralleAgent`** (alias `CfChatAgent`) — abstract base class; extend and implement `getAgents()` and `getDefaultAgentId()`.
- **`BridgeSessionStore`** — bridges Kuralle `SessionStore` interface to CF's SQLite storage.
- **`OrchestrationStore`** — Durable Object KV for orchestration state.
- **`SqlPersistentMemoryStore`** — DO SQLite-backed `PersistentMemoryStore` for USER/MEMORY blocks.

## Streaming

`onChatMessage` returns the same `UIMessageStream` every other Kuralle runtime serves, via core's `harnessToUIMessageStream`. There is no Cloudflare-specific stream adapter and nothing to configure: a client typed against `KuralleUIMessage` matches a Durable Object exactly as it matches a Node deployment.

Kuralle events arrive as `data-kuralle-*` parts, split by whether they belong in history:

| Part | Persisted? | How to read it |
| --- | --- | --- |
| `data-kuralle-handoff`, `-interactive`, `-safety`, `-outcome` | yes | `message.parts` |
| `data-kuralle-node`, `-flow`, `-control`, `-custom` | no (`transient: true`) | the `onData` callback |

Transient parts are broadcast to connected clients in real time but never enter `message.parts` — reading them from message history yields nothing. The persisted parts carry a stable per-turn id (`handoff-0`, `safety-0`, …) so a recovered turn reconciles them in place instead of appending duplicates.

## Usage

```ts
import { KuralleAgent } from '@kuralle-agents/cf-agent';
import { defineAgent } from '@kuralle-agents/core';
import { createOpenAI } from '@ai-sdk/openai';

interface Env {
  OPENAI_API_KEY: string;
}

export class SupportAgent extends KuralleAgent<Env> {
  protected getAgents() {
    const openai = createOpenAI({ apiKey: this.env.OPENAI_API_KEY });
    return [
      defineAgent({
        id: 'support',
        instructions: 'You are a helpful support agent.',
        model: openai('gpt-4o-mini'),
      }),
    ];
  }

  protected getDefaultAgentId() {
    return 'support';
  }
}

export default SupportAgent;
```

`wrangler.toml` — declare the Durable Object:

```toml
[[durable_objects.bindings]]
name = "SUPPORT_AGENT"
class_name = "SupportAgent"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["SupportAgent"]
```

## Working memory blocks

`KuralleAgent` wires `SqlPersistentMemoryStore` into `defaultWorkingMemoryStore` automatically via DO SQLite. Override in `getRuntimeConfig()` or disable by overriding `getWorkingMemoryStore()` to return `undefined`.

```ts
import { SqlPersistentMemoryStore } from '@kuralle-agents/cf-agent';

protected getRuntimeConfig() {
  return {
    defaultWorkingMemoryStore: new SqlPersistentMemoryStore(this.getSql()),
  };
}
```

## Flows and routing

Attach `flows` for structured SOPs or `routes`/`agents` for triage — same `defineAgent` primitive as Node/Bun. No runtime differences.

## Pi driver

`getRuntimeConfig()` is the single driver boundary for chat, scheduled wake, and
durable resume paths. Return `driver: new PiDriver(...)` there to use Pi by
default throughout the Durable Object. Use `nodejs_compat`, a current compatibility
date, and import only the Pi provider module you need so the Worker bundle does
not pull every provider SDK.

## Related

- [`@kuralle-agents/core`](https://www.npmjs.com/package/@kuralle-agents/core) — runtime and agent primitives.
- [`@kuralle-agents/hono-server`](https://www.npmjs.com/package/@kuralle-agents/hono-server) — HTTP/SSE router for Node.js or Bun.
- [Cloudflare Agents SDK](https://developers.cloudflare.com/agents/)
