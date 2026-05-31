# Adapters (80/20)

## Hono Server

Package: `@kuralle-agents/hono-server`

Use it to expose HTTP/SSE/WebSocket endpoints.

```ts
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { Runtime } from '@kuralle-agents/core';
import { createKuralleChatRouter } from '@kuralle-agents/hono-server';

const runtime = new Runtime({ agents: [supportAgent] });
const app = new Hono();
app.route('/', createKuralleChatRouter({ runtime }));

serve({ fetch: app.fetch, port: 3000 });
```

## Cloudflare Workers

Package: `@kuralle-agents/cf-agent`

Use for Durable Objects with WebSocket support.

```ts
import { KuralleChatAgent } from '@kuralle-agents/cf-agent';

export class MyChatAgent extends KuralleChatAgent {
  async createRuntimeConfig() {
    return { agents: [supportAgent], defaultAgentId: 'support' };
  }
}
```

## Where to read more

- `node_modules/@kuralle-agents/hono-server/README.md`
- `node_modules/@kuralle-agents/cf-agent/README.md`
