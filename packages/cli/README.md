# @kuralle-agents/cli

Kuralle's interactive chat, send, simulation, and trace inspection CLI.

```bash
kuralle chat --agent ./agent.ts --trace --store runs/demo.json
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
