# @kuralle-agents/engagement

Channel-agnostic engagement layer for Kuralle agents: window-safe outbound, closed-window recovery, interactive fidelity, handoff ownership, consent, and proactive messaging (broadcasts and drips).

Install with your messaging stack:

```bash
npm install @kuralle-agents/engagement @kuralle-agents/messaging @kuralle-agents/messaging-meta @kuralle-agents/core
```

## What it does

`@kuralle-agents/engagement` sits between **`createMessagingRouter`** (`@kuralle-agents/messaging`) and your **Runtime** (`@kuralle-agents/core`). You write flows and agents once; per-channel behavior (24h windows, template recovery, button/list rendering, inbound id routing) lives in **`ChannelPolicy`** adapters, not in bot code.

## `engagement({ policies })`

The single wiring call returns `{ bridge, broadcasts }`:

| Export | Role |
|--------|------|
| **`bridge`** | Fields to spread into `createMessagingRouter`: `outbound`, `inputResolver`, `windowStore`, `ownership`, `consent` |
| **`broadcasts`** | `BroadcastApi` for campaign sends (requires `broadcastPipeline` — see below) |

```typescript
import { createMessagingRouter, InMemoryWindowStore } from '@kuralle-agents/messaging';
import {
  engagement,
  whatsappPolicy,
  webPolicy,
  instagramPolicy,
  sessionConsentStore,
  sessionOwnershipStore,
} from '@kuralle-agents/engagement';

const windowStore = new InMemoryWindowStore();
const eng = engagement({
  policies: [
    whatsappPolicy({ client: whatsapp, selector, windowStore, wabaId }),
    webPolicy(),
    instagramPolicy({ client: instagram, windowStore }),
  ],
  consent: sessionConsentStore(sessionStore),
  ownership: sessionOwnershipStore(sessionStore),
  windowStore,
  broadcastPipeline, // optional — required for eng.broadcasts.send()
});

const router = createMessagingRouter({
  runtime,
  platforms: { whatsapp, instagram },
  ...eng.bridge,
});
```

### Outbound pipeline (window-safe)

`bridge.outbound` is built in order (gates only when the store is provided):

1. **`consentGate`** — blocks sends when the customer has opted out
2. **`ownershipGate`** — suppresses bot sends while a thread is human-owned
3. **`closedWindowRecovery`** — applies each policy’s `ClosedWindowStrategy` (templates, message tags, or defer)
4. **`interactiveRenderer`** — turns `{ type: 'interactive' }` stream parts into channel-native payloads

**`windowGuard` is not in `bridge.outbound`.** `createMessagingRouter` appends it as the terminal middleware (`buildOutboundChain(extra) = [...extra, windowGuard]`). A closed window never leaks free-form text/media/interactive to the client.

### Inbound

`bridge.inputResolver` is `[policyInboundResolver(policies)]`, which dispatches `policy.resolveInbound(message)` by `message.platform`. Unmatched platforms fall through to the router’s default text handling.

### Broadcasts

Policies do not expose outbound clients, so **`engagement()` does not construct a broadcast pipeline from policies alone**. Pass **`broadcastPipeline`** (an `OutboundPipeline` you build for the target platform, e.g. WhatsApp) plus optional **`ledger`**. Without `broadcastPipeline`, `broadcasts.send()` throws — `bridge` still works for conversational traffic.

## Channel policies

Each policy implements `ChannelPolicy`: window model, closed-window strategy, interactive rendering, and inbound mapping.

| Policy | Window | Closed window | Interactive |
|--------|--------|---------------|-------------|
| **`whatsappPolicy`** | 24h via `WindowStore` | AI template strategist (`kind: 'template'`) | Buttons (≤3), list (≤10), CTA, Flows |
| **`webPolicy`** | Always open (`hasWindow: false`) | `kind: 'none'` | Web UI buttons/lists |
| **`instagramPolicy`** | 24h | `HUMAN_AGENT` message tag for text only | Quick replies, button/generic templates |

```typescript
import { whatsappPolicy, webPolicy, instagramPolicy } from '@kuralle-agents/engagement';
```

## Authoring: choices and smart send

- **`withChoices(node, options)`** — attaches `ChoiceOption[]` to a `collect`/`decide` node; the runtime emits `{ type: 'interactive', nodeId, options, prompt }` for `interactiveRenderer`.
- **`smartSend(...)`** — action node that invokes the shared closed-window strategist (WhatsApp templates when the window is closed).
- Inbound routing uses **stable option ids** (`billing`, `support`, …), not display labels — `resolveInbound` maps button/list/postback payloads to `selection.id`.

## Consent, ownership, proactive

- **`sessionConsentStore` / `consentGate`** — opt-in/opt-out and STOP handling (customer-keyed).
- **`sessionOwnershipStore` / `ownershipGate`** — bot vs human thread ownership; human-owned inbound does not run flows.
- **`createBroadcasts` / `createDrip`** — campaign ledger idempotency and drip schedules (see exports in `src/index.ts`).
- **`createOwnershipEscalationHandler` / `resolveEscalation`** — the channel side of `HarnessConfig.escalation`: claim the thread for the human + notify on escalation; release + resume the bot (with the resolution in context) when the human is done.
- The `Scheduler` contract is owned by `@kuralle-agents/core` (re-exported here) — drips, broadcasts, and runtime wake turns (`RunOptions.wake`) share backends: in-process timers in dev, Cloudflare DO alarms via `@kuralle-agents/cf-agent`.

## Example

The multi-platform demo wires all three policies on one runtime:

`packages/kuralle-messaging-meta/examples/multi-platform/server.ts`

Offline E2E: `packages/kuralle-engagement/test/same-bot-across-channels.test.ts`.

## Related packages

- **`@kuralle-agents/messaging`** — `createMessagingRouter`, `OutboundPipeline`, `windowGuard`, `WindowStore`
- **`@kuralle-agents/messaging-meta`** — WhatsApp and Instagram clients
- **`@kuralle-agents/core`** — agents, flows, runtime

RFC: [`rfcs/whatsapp-engagement/`](../../rfcs/whatsapp-engagement/).
