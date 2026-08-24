# @kuralle-agents/client

Shared client primitives for Kuralle transports. The package is used by both `kuralle` and
`kuralle-tui`; it keeps transport/session operations separate from presentation.

## Install

```bash
npm install @kuralle-agents/client
```

## Reduce events into a view

`reduce()` folds indexed `LoggedEvent` values into a transport-agnostic `TurnView`. Pass the prior
view when a new process or stream continues an existing transcript:

```ts
import { reduce, type LoggedEvent, type TurnView } from '@kuralle-agents/client';

export function appendTurn(events: LoggedEvent[], previous?: TurnView): TurnView {
  return reduce(events, previous);
}
```

`TurnView` contains:

- `blocks` — user, assistant, tool, flow, handoff, and notice blocks;
- `status` — `idle`, `streaming`, `completed`, `waiting`, `input-required`, `escalated`, or `failed`;
- `pending` — request-bound approval or signal interrupts;
- `timings`, `usage`, `memory`, `cursor`, and `startedAt`.

The reducer is idempotent for an indexed event stream, so a consumer can fold a snapshot and then
append follow-up events without rebuilding presentation state itself.

## Create a transport client

`createClient()` accepts a local runtime target, an HTTP target, or a Cloudflare WebSocket target.
Each target exposes the same session API: `send`, `respond`, `cancel`, `stream`, and `snapshot`.

```ts
import { connectionToTarget, createClient } from '@kuralle-agents/client';

const target = connectionToTarget({
  server: 'https://my-agent.example.com',
  transport: 'http',
  agentName: 'support',
});
const client = createClient(target);
const session = client.sessions.attach('support-42');

const turn = await session.send('Check order 123');
for await (const event of turn) {
  // Fold events into a TurnView for your surface.
}
const result = await turn.result();
```

Use `connectionToTarget({ server: 'wss://...', transport: 'cloudflare', agentName: 'support' })`
for the Cloudflare transport. The transport scheme is inferred when `transport` is omitted.

## Answer input requests

For an approval or signal request, call `respond()` with the request id and response:

```ts
const turn = await session.respond([
  { requestId: 'request-1', decision: 'approve' },
]);
const result = await turn.result();
```

`buildApprovalResponse()` projects the same approval payload used by the CLI and TUI. The package
does not render a terminal UI or choose a transport policy; those belong to the consuming surface.

## Hosted deployments

Point the client at a deployment by naming the agent, and it speaks the
deployment's logged-event wire:

```ts
const client = createClient({
  kind: 'http',
  url: 'https://my-agent.example.com',
  agentName: 'support',
  auth: { token: process.env.KURALLE_TOKEN },
});
```

The turn route is asked for `?format=events`, so every event arrives with the
`index`, `eventId` and `at` the server's `SessionEventLog` assigned. `send()`,
`respond()`, `stream()` and `snapshot()` therefore all speak one identity, and a
live turn merged with a later `snapshot()` yields one copy of each event rather
than two.

A deployment must be on the same version as the client. A server older than
0.24.0 does not know `format=events` and answers its default wire instead; the
client reports that mismatch rather than mis-parsing it.

Without `agentName` the target is a single-process chat server (`/api/chat`).
That has no event log behind it, so `stream()` and `snapshot()` are unavailable
and a turn's envelope is local to that one response.
