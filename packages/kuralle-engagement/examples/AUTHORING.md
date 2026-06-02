# Authoring engagement bots — reference for the example apps

How to build a window-safe, omnichannel, free-form **+** template bot with `@kuralle-agents/engagement`. This is the shared contract for the `booking/`, `pharmacy/`, and `clothing/` example apps. Signatures below are the **public** surface (from `@kuralle-agents/engagement`, `@kuralle-agents/core`, `@kuralle-agents/messaging`).

> **Runtime:** Bun. **Live model** for the runnable app; **deterministic fakes** for tests (see § Testing).

---

## 1. The bot = a Kuralle flow agent

```ts
import { defineAgent, defineFlow, reply, collect, decide, action } from '@kuralle-agents/core';
import { z } from 'zod';
```

- **`reply({ id, instructions, next? })`** — model generates a reply, then awaits the user (or `next(turn, state)` returns a `Transition`).
- **`collect({ id, schema, required?, instructions?, onComplete })`** — model **extracts structured data** matching the zod `schema` from free-form input; `onComplete(data, state)` returns a `Transition`. **This is the free-form extraction primitive.** Extracted data merges into `state`.
- **`decide({ id, instructions, schema, decide })`** — model picks a value from `schema`; `decide(value, state)` returns a `Transition`. Routes; pair with `withChoices` for interactive.
- **`action({ id, run, verify?, outputSchema? })`** — `run(state, ctx)` runs a durable effect (`ctx.tool(name, args)` for exactly-once tool calls) and returns a `Transition`. Use for lookups / charges / writes.
- **`Transition`** = a node | `() => node` | `{ goto: node, data? }` | `{ handoff: string, reason? }` | `{ escalate: string }` | `{ end: string }` | `'stay'`.
- **`defineFlow({ name, description, start, nodes: [...] })`**, **`defineAgent({ id, name, instructions, model, flows: [flow] })`**.

`state` is the durable flow state (`Record<string, unknown>`); extracted/collected fields land here and survive resume.

### Interactive choices (rendered per channel, routed by stable id)
```ts
import { withChoices } from '@kuralle-agents/engagement';
const node = withChoices(
  decide({ id: 'pick', instructions: '...', schema: z.object({ choice: z.enum(['a','b']) }), decide: (d) => ... }),
  [{ id: 'a', label: 'Option A' }, { id: 'b', label: 'Option B', description?: '...', url?: '...', flow?: {flowId,cta} }],
);
```
`withChoices` attaches `ChoiceOption[]`; on node entry the runtime emits a `{type:'interactive'}` stream part; the engagement `interactiveRenderer` renders it per channel (WhatsApp buttons≤3/list≤10, Instagram button-template/carousel). Inbound taps resolve to the stable **id** (label-independent) and route via the node's `decide`/`onComplete`. A web UI may pass the selection as text.

### Smart template send from inside a flow
```ts
import { smartSend } from '@kuralle-agents/engagement';
const node = smartSend(strategist, { id, message: (s) => 'free text', intent?: 'reorder', window?: (s) => WindowState, next?: (decision, s) => Transition });
```
Invokes the shared strategist (same instance as the automatic guard) to convert a closed-window free-form to a template or defer.

---

## 2. Channel-safe outbound — `engagement({ policies })`

```ts
import { engagement, whatsappPolicy, webPolicy, instagramPolicy } from '@kuralle-agents/engagement';
import { createMessagingRouter, InMemoryWindowStore } from '@kuralle-agents/messaging';
import { createRuntime } from '@kuralle-agents/core';

const windowStore = new InMemoryWindowStore();
const eng = engagement({
  policies: [ whatsappPolicy({ client: wa, selector, windowStore, wabaId }), webPolicy(), instagramPolicy({ client: ig, windowStore }) ],
  consent, ownership, audit, scheduler, windowStore, ledger, broadcastPipeline,   // all optional
});
const runtime = createRuntime({ agents: [bot], defaultAgentId: bot.id, defaultModel: model });
const router = createMessagingRouter({ runtime, platforms: { whatsapp: wa, web, instagram: ig }, ...eng.bridge });
```
- `eng.bridge` = `Pick<MessagingRouterConfig,'outbound'|'inputResolver'|'windowStore'|'ownership'|'consent'|'onStatus'>` — spread it; the router appends the **non-removable terminal `windowGuard`**. Outbound chain: `[consentGate?, ownershipGate?, closedWindowRecovery(policies), interactiveRenderer(policies), windowGuard]`.
- **Window safety:** a closed-window free-form (text/media/interactive) can never leak — WhatsApp converts it to an APPROVED template (strategist) or defers; Instagram tags text with `HUMAN_AGENT` (7-day) or defers interactive/media; web is always open. Templates are window-agnostic.
- `eng.broadcasts` = a `BroadcastApi` (needs `broadcastPipeline` + `ledger` + `consent`).

### Inbound (driving turns in an example/test)
The router registers `platform.onMessage(handler)`. To drive a turn, call the handler with a normalized `InboundMessage` (`{ id, platform, threadId, customerId, from:{id}, timestamp, type, text? | interactive?:{type,id,title} | button?:{payload,text} }`). `customerId` is the consent key; `threadId` (= `sessionId` via the default resolver) is the conversation/window key. Multi-turn = call the handler repeatedly on the same `threadId`.

---

## 3. Templates (closed-window + proactive)

```ts
import { createSmartSendStrategist, whatsappTemplateCatalog, aiTemplateSelector,
         type TemplateCatalog, type TemplateSelector, type TemplateDescriptor } from '@kuralle-agents/engagement';
```
- **`TemplateCatalog`** = `{ approved(): Promise<TemplateDescriptor[]>; validateParams(name, params): {ok; errors?} }`. For examples, an **inline catalog** is fine:
  ```ts
  const catalog: TemplateCatalog = {
    async approved() { return [{ name:'appt_reminder', language:'en_US', category:'utility', status:'APPROVED', quality:'GREEN', params:[{key:'1',required:true}] }]; },
    validateParams(name, p) { return { ok: '1' in p, errors: '1' in p ? undefined : ['missing param 1'] }; },
  };
  ```
- **`TemplateSelector`** = `{ select({text, intent?, candidates, flowState?}): Promise<{name; language; params} | null> }`. Use `aiTemplateSelector(model)` in the live app; a **mock selector** in tests.
- `whatsappPolicy({ client, selector, windowStore, wabaId })` builds the strategist internally from `whatsappTemplateCatalog({client, wabaId})`. For an example without a live Meta `templates.list`, pass a fake client whose `templates.list` returns your approved descriptors' `TemplateInfo`, OR construct the strategist yourself and pass a policy with `closedWindow:{kind:'template', strategist}`.
- **Proactive:** `engagement().broadcasts.send(campaign)` (idempotent via `BroadcastLedger`), and `createDrip({ scheduler, pipeline, sessionStore, platform, windowStore })` for per-step delays + stop-on-reply + re-engagement templates.

---

## 4. Consent / ownership / proactive

```ts
import { sessionConsentStore, sessionOwnershipStore, createInProcessScheduler,
         createInMemoryBroadcastLedger, createBroadcasts, createDrip } from '@kuralle-agents/engagement';
const consent = sessionConsentStore(sessionStore, { defaultOptedIn: false }); // REQ-11: default opted-out
const ownership = sessionOwnershipStore(sessionStore);
```
- `consent` (customer-keyed): `STOP` opts out; `consentGate` blocks un-opted-in outbound (`deferred:'not-opted-in'`). An app that sends proactively must `consent.optIn(customerId)` first.
- `ownership` (conversation-keyed): `escalate:'human'` claims ownership; while human-owned the inbound gate skips the flow; `ownership.release(threadId)` resumes.
- `sessionStore`: pass `runtime.getSessionStore()` (the same store the runtime uses) so consent/ownership share state.

### Durable stores (multi-process / serverless)

`InMemoryWindowStore` and `createInMemoryBroadcastLedger` are single-process defaults. For horizontal scale, inject any Redis-compatible client through the minimal `RedisLikeClient` surface (`get` / `set` with optional `PX`+`NX` / `del`). ioredis, node-redis, and Upstash clients all work via a thin adapter — no dependency on `@kuralle-agents/redis-store`.

```ts
import type { RedisLikeClient } from '@kuralle-agents/messaging';
import { createRedisWindowStore } from '@kuralle-agents/messaging';
import { createRedisBroadcastLedger } from '@kuralle-agents/engagement';

// Example: ioredis — map set() to PX/NX when opts is present
const client: RedisLikeClient = {
  get: (key) => redis.get(key),
  del: (key) => redis.del(key),
  set: (key, value, opts) =>
    opts?.nx
      ? redis.set(key, value, 'PX', opts.pxMs ?? 0, 'NX')
      : opts?.pxMs != null
        ? redis.set(key, value, 'PX', opts.pxMs)
        : redis.set(key, value),
};

const windowStore = createRedisWindowStore(client, { keyPrefix: 'myapp:' });
const ledger = createRedisBroadcastLedger(client, { keyPrefix: 'myapp:' });

const eng = engagement({ policies: [...], windowStore, ledger, ... });
```

Window keys expire automatically (`win:<threadId>` → expiry epoch-ms). Broadcast ledger keys use `SET NX` for campaign idempotency (optional `ttlMs`; omit for durable campaign dedupe).

---

## 5. Testing — deterministic, offline (no live model, no live Meta)

- **Fake model** for flow turns: `import { MockLanguageModelV3 } from 'ai/test';` and return canned content from `doGenerate` (text) or a structured object/tool-call for `collect`/`decide` extraction. Pattern reference: `packages/kuralle-core/test/core-policy/contextStrategy.test.ts`.
  ```ts
  const model = new MockLanguageModelV3({ doGenerate: async () => ({ content:[{type:'text', text:'...'}], finishReason:'stop', usage:{inputTokens:1,outputTokens:1,totalTokens:2}, warnings:[] }) as never });
  ```
  For `collect` extraction in a test, return the structured payload the schema expects (inspect how the runtime invokes the model for collect — `generateObject`-style; the mock's `doGenerate` must return content the extractor parses into the schema). If faithfully faking structured extraction is too costly, drive routing via an explicit **button-tap inbound** (resolves to `selection.id` → routes deterministically, no model) and keep one **live-only** extraction smoke (env-gated, skipped when no key).
- **Mock `TemplateSelector`** (deterministic) for closed-window template conversion: `{ select: async () => ({ name:'appt_reminder', language:'en_US', params:{'1':'value'} }) }`.
- **Fake platform clients** (record sends; no live Meta) — mirror `packages/kuralle-messaging/test/unhappy-paths.test.ts` `createMockPlatform`. Assert observable `SendOutcome`s / recorded sends, not model wording.
- **Assert the framework mechanics** (model-independent): free-form extraction lands in `state`; a closed-window send converts to the expected template (mock selector) or defers; interactive choices render per channel and route by stable id; `consentGate`/STOP block; broadcast/drip idempotent.

---

## 6. App layout (per example)
```
examples/<app>/
  bot.ts          # flow agent(s) + engagement() wiring; exports the bot + a buildRouter(...) for tests; live-model via env
  run.ts          # runnable entry: drives a scripted multi-turn conversation (live model if key present, else prints SKIP)
  <app>.test.ts   # deterministic tests (MockLanguageModelV3 + mock selector + fake clients)
  README.md       # what it demonstrates + how to run
  tsconfig.json   # extends the package tsconfig; included in typecheck:all sweep
```
**Gates:** `bun run build` + `bun run typecheck:all` green (the example tsconfig must be in the sweep); `bun test packages/kuralle-engagement` green; no live keys required for tests; no `--no-verify`/`@ts-ignore`/silent catch; no source maps.
