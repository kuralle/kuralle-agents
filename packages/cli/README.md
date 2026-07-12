# @kuralle-agents/cli

Kuralle's interactive chat, send, simulation, and trace inspection CLI.

```bash
kuralle trace session-42
kuralle trace session-42 --last
kuralle trace session-42 --json
kuralle trace session-42 --web --port 4319
```

The terminal view prints a span waterfall with durations and tool, handoff, and
error markers. `--json` returns the native `AgentTrace` JSON for agents and CI.
`--web` starts a loopback-only read-only viewer backed by the runtime's configured
native `TraceStore`; its JSON routes are `/api/traces/:session` and `/api/trace/:id`.

Custom agent modules export `buildRuntime(sessionId?, store?)`. Configure a durable
trace store on that runtime when traces must survive separate CLI invocations.
