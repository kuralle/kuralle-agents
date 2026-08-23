# @kuralle-agents/cli

The agent-facing `kuralle` CLI. It runs one turn per process, persists the session event log, and
writes a status-discriminated JSON `TurnResult` for scripts and other agents. The human-facing
OpenTUI chat surface is a separate package: [`@kuralle-agents/tui`](../tui).

## Install

```bash
npm install -g @kuralle-agents/cli
```

The CLI accepts the global options `--agent <path.ts>` and `--model <id>`. `--agent` may point to a
`Runtime`, a `defineAgent` export, or a `buildRuntime` factory. `--model` supplies the model for a
bare agent export with no model of its own.

## One turn and process-to-process resume

`send` is one turn against a persisted session. `--store` is a JSON-backed session/event-log path:

```bash
STORE=runs/agent-session.json
kuralle send --session support-42 --store "$STORE" "What is the status of order 123?"
```

Pipe the previous `TurnResult` to a new process with `--resume`:

```bash
T1=$(kuralle send --session support-42 --store "$STORE" "Hi, I am Mithushan.")
echo "$T1" | kuralle send --resume --store "$STORE" "What is my name?"
```

`message` is only the reply from the current turn. `view.blocks` is the cumulative transcript and
grows as resumed turns are folded into the same view.

## JSON contract

Turn commands write JSON on stdout. `kuralle schema` prints the `TurnResult` JSON Schema:

```bash
kuralle schema
```

The status discriminator is `completed`, `waiting`, `input-required`, `escalated`, `failed`, or
`auth-required`. The process exit codes are:

| Code | Meaning |
| ---: | --- |
| `0` | completed or waiting |
| `1` | failed turn |
| `2` | usage error |
| `3` | input-required or auth-required |

With `--stream`, stdout is NDJSON: `LoggedEvent` lines first and the final `TurnResult` last.

```bash
kuralle send --session support-42 --store "$STORE" --stream "Check the order"
```

## Approvals and escalation

An `input-required` result contains `requests` and pending request details. Pipe that result back
with `--resume` and answer an approval request with `--respond`:

```bash
printf '%s\n' "$PENDING" | kuralle send --session support-42 --store "$STORE" \
  --resume --respond '[{"requestId":"<request-id>","decision":"approve"}]'
```

Use `"deny"` to reject it. Use the separate `resume` command only after a human escalation has
been resolved:

```bash
kuralle --agent ./agent.ts resume support-42 --store "$STORE" --summary "Identity verified."
```

## Memory, history, and cancellation

Local memory reads require both `--user` and `--agent` because the agent supplies the memory
configuration:

```bash
kuralle memory --user mithushan --agent ./agent.ts
```

Extraction defaults to `{ tokens: 2000 }`, so a short turn can correctly produce
`{"blocks":[],"extracted":[]}`. Set `memory: { extraction: { trigger: 'each-turn' } }` to extract
after every turn. Node’s default file store writes extracted values under
`~/.kuralle/extracted/user/<id>/<slug>.json`.

```bash
kuralle --agent ./agent.ts history --session support-42 --store "$STORE"
kuralle --agent ./agent.ts cancel --session support-42 --store "$STORE"
```

`history` prints the session `TurnView`. `cancel` prints `cancelled` or `no_active_turn` as JSON.

## Hosted and deployable runtimes

Save a non-secret hosted target for later commands:

```bash
kuralle connect https://my-agent.example.com --agent-name support
kuralle connection
kuralle disconnect
```

Credentials are never written to the connection file. Supply a bearer token through
`KURALLE_TOKEN` (or the hosted command’s token option).

The remaining commands are `sim`, `trace`, `build`, and `start` for simulation, trace inspection,
artifact creation, and starting a built Node server artifact. `kuralle chat` no longer starts an
interactive surface; it exits `2` and points to `kuralle-tui`.

See the complete [Agent CLI guide](https://agents.kuralle.com/guides/cli-agent) and the
[Chat TUI guide](https://agents.kuralle.com/guides/cli-chat).

## Migration

| Old surface | New surface |
| --- | --- |
| `kuralle chat` | `kuralle-tui` |
| prose stdout | JSON |
| `--approve` / `--deny` / `--signal` | `--respond` |
| `--auto` | piped `--resume` |
