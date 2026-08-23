# TUI chat → moved to `@kuralle-agents/tui`

The interactive terminal chat now lives in the dedicated
**[`@kuralle-agents/tui`](../../../tui)** package, so `@kuralle-agents/core`
stays lean and the human and agent surfaces remain separate.

```bash
# from a Kuralle project; Bun is required
bunx kuralle-tui
```

Use **[`@kuralle-agents/cli`](../../../cli)** for agent-facing JSON turns, `send`, `resume`,
simulation, trace inspection, and the file-backed dev `SessionStore`. Production uses a durable
backend — Durable Object SQLite (Cloudflare), Redis, or Postgres.
