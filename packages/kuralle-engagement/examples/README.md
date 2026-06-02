# `@kuralle-agents/engagement` — example apps

Three deep, end-to-end bots built on the engagement layer, demonstrating **free-form extraction**, **template-based** (closed-window) sends, and **mixed** conversations across WhatsApp / web / Instagram. See [`AUTHORING.md`](./AUTHORING.md) for the API + patterns.

Each app: `bot.ts` (flow agent + `engagement({policies})` wiring), `run.ts` (live-model multi-turn demo; **offline Meta** — fake clients record sends), `<app>.test.ts` (deterministic, offline — `MockLanguageModelV3` + mock `TemplateSelector` + fake clients), `README.md`, `tsconfig.json` (in the `typecheck:all` sweep).

| App | Demonstrates |
|-----|--------------|
| [`booking/`](./booking/) | Reservations: **free-form extraction** (date/time/party/name) → availability → **interactive slot choices (routed by stable id)** → confirm → book; **closed-window hold-reminder template**. |
| [`pharmacy/`](./pharmacy/) | Prescription orders: identity/insurance/address **extraction**, id-routed Rx + pickup/delivery, **approval-gated copay** (`needsApproval`), **consent/STOP**, escalate→human ownership, **closed-window refill-reminder template** + idempotent broadcast. |
| [`clothing/`](./clothing/) | Store: **interactive** product/size/color (id-routed; size renders WhatsApp list / Instagram carousel), **cart grow/shrink across turns**, checkout address **extraction**, payment, **idempotent opt-in-only promo broadcast template**. |

## Run a live demo (real model, no live Meta)
```bash
# needs a provider key in .env; pick one explicitly
KURALLE_EXAMPLE_PROVIDER=openai bun run packages/kuralle-engagement/examples/booking/run.ts
KURALLE_EXAMPLE_PROVIDER=openai bun run packages/kuralle-engagement/examples/pharmacy/run.ts
KURALLE_EXAMPLE_PROVIDER=openai bun run packages/kuralle-engagement/examples/clothing/run.ts
```
`KURALLE_EXAMPLE_PROVIDER` ∈ `openai | google | xai`. Without a key the runner prints `SKIP`. (Note: the legacy `google` default model `gemini-2.0-flash` is retired upstream — use `openai`, or set a current Google model.)

## Tests (deterministic, no keys, no live Meta)
```bash
bun test packages/kuralle-engagement      # all three apps' suites + the framework suite
bun run typecheck:all                     # sweeps each example tsconfig
```

> The runnable `run.ts` demos are part of the validation, not just the tests: a live booking run surfaced (and we fixed) a flow oscillation that the offline tests missed — "an untested example is a broken example" (see the repo's `CLAUDE.md` gotchas).

## Deploy on a real WhatsApp number

These apps run offline (fake Meta clients). To deploy a bot against a real WhatsApp Cloud API number (bring your own token, no Embedded Signup), see the self-hostable server at [`packages/kuralle-messaging-meta/examples/whatsapp-server/`](../../kuralle-messaging-meta/examples/whatsapp-server/) — same `engagement({ policies })` wiring, served on Bun or Node with an optional Redis `WindowStore`.
