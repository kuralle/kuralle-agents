# Chat TUI

Run the Bun-powered kuralle-tui surface for interactive human conversations.

This guide shows you how to use `@kuralle-agents/tui`, the human-facing OpenTUI chat surface for
Kuralle sessions. The agent-facing [`kuralle` CLI](./cli-agent.md) emits JSON and is a separate
binary.

> **Bun is required**
>
> Install and run `@kuralle-agents/tui` with **Bun**. Node is not a supported runtime for this
>   package. Although Node 26.1+ can expose `bun:ffi` with `--experimental-ffi`, that is not a
>   supported path for `kuralle-tui`.

## Start the chat surface

Install the package in the project that owns your agent or use Bun’s package runner:

```bash
bun add @kuralle-agents/tui
bunx kuralle-tui
```

With no target, `kuralle-tui` boots into a connect screen. Press Enter to use the saved hosted
connection, or enter one of the slash commands shown by `/help`.

## Connect to a target

If you want a hosted HTTP target, pass its URL:

```bash
bunx kuralle-tui https://my-agent.example.com --agent-name support
```

> **Match the deployment's version**
>
> From 0.24.0 a hosted turn is read from the deployment's session event log, over
> `?format=events`. A server older than 0.24.0 does not know that format and
> answers its browser wire instead; the client reports the mismatch rather than
> mis-parsing it. Upgrade the deployment and the CLI together.

If you want a local agent, pass its filesystem path:

```bash
bunx kuralle-tui ./agent.ts
```

Pass a hosted URL or local agent path as the first positional argument, or use `--server <url>` for
the same hosted target. Use `--local <path.ts>` to load a local agent explicitly instead of relying
on scheme inference from a filesystem path.

Transport is inferred from the target scheme: `http://` and `https://` use `http`, `ws://` and
`wss://` use `cloudflare`, and a filesystem path uses `local`. Use `--transport` to override the
inference. Cloudflare targets also require `--agent-name`.

Use `--session <id>` to attach to an existing session and `--user <id>` to scope memory for the
session. For a token in a non-default environment variable, use `--token-env VAR`; otherwise the
TUI reads `KURALLE_TOKEN`. When a local agent export has no model, pass `--model <id>`. To load
environment variables from a file other than `./.env`, use `--env-file <path>` (real environment
variables still win). Run `kuralle-tui --help` to print the full launch contract.

## Use slash commands

Type these commands into the connect screen or chat composer:

| Command | Action |
| --- | --- |
| `/connect <url> [--agent-name x] [--transport http\|cloudflare] [--token-env VAR]` | Connect to a hosted or local target and create a session |
| `/agent <path.ts> [--model id]` | Load a local agent and create a session |
| `/session <id>` | Attach to an existing session |
| `/user <id>` | Set the memory owner for new turns |
| `/disconnect` | Drop the active target and return to the connect screen |
| `/connection` | Show the active and saved connection |
| `/save` | Save the active hosted target as the default |
| `/memory` | Focus the memory rail |
| `/trace` | Focus the trace rail |
| `/reset` | Start a new session on the active target |
| `/help` | Show the command list |
| `/quit` | Exit the TUI |

`/save` writes only `{ server, transport, agentName }`. It never writes a credential. Tokens come
from the environment through `--token-env VAR` or `KURALLE_TOKEN`.

## Switch the rail

When the terminal is wide enough for the side rail, press `^t` to show Trace and `^m` to show
Memory. The Trace rail follows the current turn’s spans, timing, and token line. The Memory rail
shows working-memory blocks, extracted values, and compactions when the agent has memory configured.

## Approve or deny a tool call

When a turn pauses for a tool approval, the TUI opens its approval panel, shows the operation and
arguments, and disables the composer. Choose Approve or Deny in the panel; the TUI sends the
request-bound response and resumes the same session. This is the human approval path; an agent
driving the CLI should use [`kuralle send --resume --respond`](./cli-agent.md#respond-to-an-approval-request).

## Cancel a streaming turn

While a turn is streaming, the composer is hidden. Slash commands are therefore not reachable
mid-turn. Press `^c` to cancel first; once the turn stops, the composer and slash commands are
available again.

> **Streaming input is intentionally unavailable**
>
> A slash command typed while the composer is hidden cannot be delivered to the TUI. Cancel the
>   active turn before trying `/connect`, `/reset`, `/memory`, or another command.

## Move from the agent CLI

If an old integration used `kuralle chat`, install `@kuralle-agents/tui` and invoke `kuralle-tui`.
Keep [`@kuralle-agents/cli`](./cli-agent.md) for JSON turns, approvals, streaming NDJSON,
memory reads, cancellation, history, and process-to-process resume.
