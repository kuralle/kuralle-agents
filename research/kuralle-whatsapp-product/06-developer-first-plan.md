# 06 — Developer-first plan (COMMITTED direction)

**Decision (2026-06):** Kuralle goes **developer-first**. The product is the engine + SDK + the developer loop around it, sold to devs/platform teams building *transactional* WhatsApp/omnichannel bots. B2B2C/white-label ([`05`](./05-gtm-model.md)) is the *later scale layer*, unlocked by developer-channel pull — **not built now**. Direct-B2B-SaaS (visual builder, team inbox, marketing-blast UI) is **explicitly deprioritized**.

Why this fits: dev-first leans directly on the **lead moats** (durable exactly-once engine + window-safety-by-construction + code-first structured flows — [`04`](./04-moat.md)), needs the **least net-new UI**, and is the natural on-ramp to the B2B2C channel where the engine compounds. It also dodges the two crowded, UI-heavy traps (no-code builder, marketing broadcast).

## What "developer-first" means for the product
| Invest now (the dev product) | Status | Effort | Why |
|---|---|---|---|
| **SDK + primitives DX** (`defineAgent`/flows/`engagement({policies})`) — types, ergonomic errors, stable public surface | HAVE | S (polish) | The product. Make it a joy to write a correct bot. |
| **Docs + cookbook** (Astro site, full guides, API ref, the 3 example apps as recipes, `AUTHORING.md`) | PARTIAL | **M (top priority)** | #1 PLG asset for dev-first; how devs discover + adopt. |
| **`create-kuralle-agents` scaffolder + WhatsApp-bot starters** | HAVE/PARTIAL | S | `npm create kuralle-agents` → running bot in minutes. |
| **`kuralle dev` CLI + headless simulator** (wrap the fake-client harness: run a bot locally, simulate WhatsApp/IG/web turns, see per-channel render + window state, no Meta creds) | PARTIAL | M | The tight inner loop. Our offline fake-client is already this — productize it. |
| **Self-host + deploy** (hono-server Node/Bun + cf-agent Workers/DO) — turnkey "deploy your bot" | HAVE-ish | S–M | Devs run it themselves; remove friction. |
| **Durable store adapters** (Redis/Postgres for window/ownership/consent/ledger — BK-06) | PARTIAL | S–M | Required for real single-process→multi-process prod. |
| **Observability** — lean on Langfuse/OpenTelemetry hooks (NOT a built dashboard) | PARTIAL | S | Devs use their own tooling; expose clean hooks + traces. |
| **Connectivity:** bring-your-own WhatsApp Cloud API number/token; web widget via `webPolicy` | HAVE | S | Devs bring their own WABA — no onboarding flow needed. |

## What we explicitly DEFER (not developer-first)
- **Visual no-code flow builder** (XL) — devs write code. *(The flow-IR/canvas only matters for B2B2C/no-code later.)*
- **Live team-inbox UI** (XL) — ship the ownership *gate* + events + a reference integration; let devs build/embed the inbox. Full surface is B2B2C.
- **Meta Embedded Signup onboarding** (L) — devs bring their own number; Embedded Signup is a self-serve/B2B2C feature.
- **Multi-tenant control plane + billing** (L) — that's the B2B2C platform.
- **CRM/segments + analytics dashboards** (L) — expose the data + `HarnessStreamPart`/audit stream; don't build BI.
- **Template-approval workflow UI** — devs submit via Meta/API; we consume the catalog (`catalog.ts`).

## PLG motion (how dev-first actually grows)
1. **OSS core + exceptional docs** → mindshare (the Rasa/LangGraph playbook). The example apps (booking/pharmacy/clothing) are the on-ramp.
2. **5-minute win:** `npm create kuralle-agents` → a bot running locally against the simulator → deploy button (Cloudflare/Node).
3. **Monetize later, not first:** a hosted **"Kuralle Cloud"** (managed durable runtime + stores + scaling) on usage-based pricing; OSS stays the wedge. Don't gate adoption behind payment early.
4. **Distribution:** docs SEO, recipes, "deploy to X" buttons, a dev community; talk *reliability/correctness* (exactly-once, can't-leak) — the thing devs can't easily build.

## Success signals & the B2B2C flip trigger
- **Adoption:** installs, bots in production, stars/Discord, recipe usage.
- **Quality of pull:** are *agencies / vertical-SaaS / platforms* among adopters asking "can I white-label / manage clients / sub-accounts"? **That pull is the trigger to build the B2B2C platform (`05`).** Until then, don't build multi-tenant.
- **Monetization:** conversion to hosted Cloud once a cohort runs prod workloads.

## Honest risks (dev-first specific)
- **Narrow TAM + devs are cheap.** Mitigate: OSS-for-reach + paid hosted runtime + treat dev-first as the *on-ramp* to B2B2C, not the whole business.
- **OSS support burden / monetization timing.** Keep the paid line (managed durability + scale + SLAs) clearly above the free line.
- **"Reliability is invisible until it fails"** — lead the docs with concrete failure-avoidance stories (the booking-oscillation catch, can't-leak, exactly-once charge) so the moat is legible, not abstract.

## Flip conditions
- **Open the B2B2C layer (`05`) when** ≥ a handful of adopters are agencies/platforms explicitly pulling for white-label/multi-tenant.
- **Reconsider dev-first as primary if** after ~2–3 quarters adoption is flat AND no partner pull — then weigh direct-vertical (e.g. pharmacy/commerce compliance) or engine-licensing.
- **Don't** start building the visual builder / team-inbox / multi-tenant control plane before that pull exists — it's the deferral that keeps dev-first cheap and focused.
