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
- **`createSSEResponse`** — helper for streaming SSE responses from Workers.

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

## Flows and routing

Attach `flows` for structured SOPs or `routes` + `routing: { mode: 'structured' }` for triage — same `defineAgent` primitive as Node/Bun. No runtime differences.

## Related

- [`@kuralle-agents/core`](https://www.npmjs.com/package/@kuralle-agents/core) — runtime and agent primitives.
- [`@kuralle-agents/hono-server`](https://www.npmjs.com/package/@kuralle-agents/hono-server) — HTTP/SSE router for Node.js or Bun.
- [Cloudflare Agents SDK](https://developers.cloudflare.com/agents/)
