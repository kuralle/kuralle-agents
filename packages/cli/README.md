# @kuralle-agents/cli

Kuralle's interactive chat, send, simulation, and trace inspection CLI.

## Build immutable file agents

```bash
kuralle build --agent ./agent --target node \
  --default-model openai/gpt-5-mini --host ./deployment.node.ts
kuralle start --app .kuralle/node/server.mjs

kuralle build --agent ./agent --target cloudflare \
  --default-model openai/gpt-5-mini --host ./deployment.cloudflare.ts \
  --d1-id <database-id> --d1-name my-agent-control --r2-bucket my-agent-blobs
wrangler deploy --config .kuralle/cloudflare/wrangler.jsonc
```

The Node result is one `server.mjs` plus a non-root production Dockerfile. The Cloudflare result is
one Worker module plus DO migration, D1, optional R2, compatibility flags, and observability config.
Both contain the same canonical artifact, capability hashes, and content-addressed bytes. Host
factories provide credentials, model instances, authentication, durable stores, and trusted runtime
capabilities; those values are intentionally never serialized into the artifact.

See [File-authored agent deployment](../../docs/guides/file-agent-deployment.md).

## Hosted runtimes (default after connect)

Connect once to a deployed Next.js/Hono/Worker HTTP endpoint. Subsequent `chat`
and `send` commands execute in that hosted runtime, so the server—not the CLI
process—owns conversation state, tools, credentials, and workspaces.

```bash
kuralle connect https://my-agent.vercel.app
kuralle send --session customer-42 "What is in my cart?"
kuralle chat --session customer-42
```

Cloudflare Agents can also use their native WebSocket protocol, including the
standard `/agents/{agent-name}/{instance-name}` identity boundary:

```bash
kuralle connect https://my-agent.workers.dev \
  --transport cloudflare --agent-name pharmacy-agent
kuralle chat --session customer-42 --auto "hello|check amoxicillin 500 mg|what did I ask for?"
```

`kuralle connection` shows the saved non-secret connection and `kuralle
disconnect` removes it. Use `--local` to opt into the in-process agent while a
hosted server is connected. `--server`/`KURALLE_SERVER` provide a one-command
override. Auth tokens are never saved in the connection file; provide
`KURALLE_TOKEN` (preferred) or `--token`.

The HTTP transport first uses `POST /api/chat` with `{ sessionId, message }` and
falls back to Kuralle's Hono SSE endpoint at `/api/chat/sse`. The Cloudflare
transport speaks the native Agents chat protocol, accepts its direct AI SDK JSON
parts, and prefers a final persisted-message broadcast when the server sends one.

## Local runtimes

```bash
kuralle chat --local --agent ./agent.ts --trace --store runs/demo.json
kuralle chat --agent ./agent.ts --auto "hello|yes, continue" --trace --store runs/demo.json
kuralle trace session-42
kuralle trace session-42 --last
kuralle trace session-42 --json
kuralle trace session-42 --web --port 4319
```

Chat prints TTFT and total duration after every turn. Its live trace panel and
the terminal trace view show TTFT plus a span waterfall with durations and tool,
handoff, and error markers. TTFT is measured from runtime trace creation to the
first non-empty client `text-delta`; tool-only work before speech is included.
`--json` returns the native `AgentTrace` JSON for agents and CI.
`--web` starts a loopback-only read-only viewer backed by the runtime's configured
native `TraceStore`; its JSON routes are `/api/traces/:session` and `/api/trace/:id`.

Custom agent modules may export an `AgentConfig`, a `Runtime`, or
`buildRuntime(sessionId?, sessionStore?, traceStore?)`. Pass `--store` to persist
both session state and the native trace sidecar across separate CLI invocations.

To use Pi (the recommended application driver), export a `Runtime` or
`buildRuntime` factory configured with `HarnessConfig.driver: new PiDriver(...)`.
The CLI preserves that runtime-level driver for chat, send, simulation, resumes,
and tracing. A bare `AgentConfig` export deliberately uses Core's AI SDK fallback
because it does not carry the Pi provider registry or credential resolver.
