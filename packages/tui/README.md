# @kuralle-agents/tui

Human-facing OpenTUI chat surface for Kuralle sessions. It provides the `kuralle-tui` binary and
shares the event reducer and transport client from `@kuralle-agents/client`.

## Bun is required

Run this package with **Bun 1.3+**:

```bash
bun add @kuralle-agents/tui
bunx kuralle-tui
```

Node is not a supported runtime for `kuralle-tui`. Node 26.1+ can expose `bun:ffi` with
`--experimental-ffi`, but that is not a supported path for this package.

## Targets

With no target, the TUI opens its connect screen. Pass a hosted URL or a local agent path:

```bash
bunx kuralle-tui https://my-agent.example.com --agent-name support
bunx kuralle-tui ./agent.ts
```

`http(s)://` infers HTTP, `ws(s)://` infers Cloudflare, and a filesystem path infers local.
`--transport` overrides the inference. Tokens come from `--token-env VAR` or `KURALLE_TOKEN` and
are never saved by `/save`.

The interactive surface provides `/connect`, `/agent`, `/session`, `/user`, `/disconnect`,
`/connection`, `/save`, `/memory`, `/trace`, `/reset`, `/help`, and `/quit`. `^t` focuses Trace;
`^m` focuses Memory. Pending tool approvals use the approval panel and disable the composer until
the request is approved or denied.

While a turn is streaming, the composer is hidden and slash commands are unavailable. Press `^c`
to cancel the turn before entering a slash command.

See the complete [Chat TUI guide](https://agents.kuralle.com/guides/cli-chat) and the
[Agent CLI guide](https://agents.kuralle.com/guides/cli-agent).
