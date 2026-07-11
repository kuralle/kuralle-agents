# TUI chat → moved to `@kuralle-agents/cli`

The interactive terminal chat (Ink TUI), the adaptive single-turn `send` loop,
the persona-driven `sim`, and the file-backed dev `SessionStore` now live in the
dedicated **[`@kuralle-agents/cli`](../../../cli)** package, so `@kuralle-agents/core`
stays lean (no Ink/React in its dependency graph).

```bash
# from a Kuralle project
npx @kuralle-agents/cli chat     # interactive Ink TUI
npx @kuralle-agents/cli send     # one turn against a file-persisted session (adaptive/agent-driven)
npx @kuralle-agents/cli sim      # persona-driven simulateConversation
```

The file-backed `SessionStore` there is **dev-only**. Production uses a durable
backend — Durable Object SQLite (Cloudflare), Redis, or Postgres.
