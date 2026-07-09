# Kuralle — Brand Context

> Single source of truth for Kuralle written voice. Every README, doc page, and
> landing section reads this **before** generating. Pairs with
> `.handoff/docs-revamp/API-FACTSHEET.md` (which governs technical accuracy).
> Voice anchor: **OpenAI Agents SDK** README/docs, seasoned with the directness of
> `qmd` and the confidence of LangChain `deepagents`.

## Brand Foundation
- **Name:** Kuralle (packages scoped `@kuralle-agents/*`)
- **One-liner:** A TypeScript framework for building conversational AI agents — text and voice — with structured flows, routing, and durable tool execution.
- **Category:** Open-source AI agent framework / developer tooling
- **Business Model:** Open-source framework (npm), TypeScript-first
- **Stage:** Early development, approaching first public release
- **Mission:** Make production-grade conversational agents — the kind that follow real procedures, route between specialists, and survive restarts — buildable with a handful of primitives instead of a state-machine rewrite.
- **Core Values:** Correctness over cleverness · Few primitives, composed · Procedures belong in flows, not prompts · Same agent, text or voice · No shortcuts.

## Target Audience
- **Primary ICP:** TypeScript/Node engineers building customer-facing conversational agents (support, sales, intake, voice) who have outgrown a single system prompt.
- **Decision Makers:** Senior/staff engineers, eng leads choosing an agent framework.
- **Jobs to Be Done:**
  - Functional: Build an agent that follows a multi-step procedure, calls tools deterministically, routes to specialists, and runs over both chat and voice — without hand-rolling a state machine.
  - Emotional: Confidence it won't fall apart in production; relief at how little code it takes.
  - Social: Be seen shipping something robust, not a demo.
- **Pain Points:** SOPs crammed into bloated prompts; brittle hand-written routing; tools that leak chat text or double-execute on retry; voice and text needing two separate stacks; frameworks with 40 concepts before "hello world."
- **Trigger Events:** A prompt-only agent breaks at scale; a voice requirement lands; a refactor of a 500-line conversation state machine.
- **Where They Hang Out:** GitHub, npm, Hacker News, X/Twitter dev circles, TypeScript/AI Discords.

## Brand Voice

### Voice Attributes (1–10)
- **Formal ←→ Casual:** 6 — relaxed and human (contractions, direct address) but never sloppy.
- **Serious ←→ Playful:** 4 — mostly serious; an occasional dry, opinionated line is welcome, jokes are not.
- **Technical ←→ Accessible:** 7 (technical) — we assume a competent engineer and don't over-explain, but we never gatekeep.
- **Reserved ←→ Bold:** 7 (bold) — we make claims and take positions ("SOP lives in flows, not prompts") and back them with code.

### Voice DNA
- **We sound like:** the OpenAI Agents SDK docs (clear, confident, primitive-first), `qmd`'s terse authority, a senior engineer writing the README they'd want to read.
- **We never sound like:** a marketing landing page, a breathless launch tweet, or enterprise middleware brochures.
- **Personality in 3 words:** Precise. Confident. Direct.

### Writing Rules
- **Sentence structure:** Mixed — short, declarative lead sentences; longer ones only when earning a nuance. Lead with the point.
- **Vocabulary:** Plain technical English. Define a coined term once, then use it freely.
- **Jargon policy:** Use real terms (flow, node, transition, effect log, handoff) freely; define each on first use in a given doc.
- **Contractions:** Yes.
- **Exclamation marks:** Effectively never (≤1 per page, and only for genuine emphasis).
- **Emoji:** Never in prose. (Sparingly OK as section/callout glyphs in a README header table, matching openai-agents-js restraint.)
- **First person:** "Kuralle" or "you." Use "we" only for design-rationale asides ("We made two bets…"). Address the reader as "you."
- **Tense/mood:** Active voice, imperative for instructions ("Define an agent," "Run it").

### Structural conventions (mirror openai-agents-js)
- Open with a one-sentence what-it-is, then a short pitch paragraph, then the primitives.
- **Primitives as a short bold-lead bullet list:** `**Agents** — LLMs with instructions and tools`.
- A **"Why Kuralle"** section framed as design principles ("Enough to be worth it, few enough to learn fast").
- Code examples are the argument — show, then explain in 1–2 sentences. Prefer real, runnable snippets.
- Use comparison tables for "which package / which path."
- Callouts (`<Aside>`) for gotchas, not walls of warning text.

### Golden Samples (write like these)
1. *(one-liner)* "Kuralle is a TypeScript framework for building conversational agents with structured flows, routing, and durable tool execution — the same agent runs over text or voice."
2. *(pitch)* "Most agent frameworks give you a prompt and a tool-call loop. That's fine until the conversation has steps — collect these fields, confirm, then book. Kuralle puts those steps in a **flow**: a small graph of typed nodes with real control flow, so your procedure lives in code you can test, not in a 600-line system prompt."
3. *(primitive bullet)* "**Flows** — node graphs (`reply`, `collect`, `action`, `decide`) where each node returns its next transition. Your SOP becomes a typed state machine you didn't have to hand-write."
4. *(opinionated aside)* "Rule of thumb: if you're pasting more than ~20 lines of procedure into a system prompt, it belongs in a flow."
5. *(feature line)* "**Durable tools** — every tool effect is logged and replayed, so a retried turn never double-charges a card or double-books a slot."

### Anti-Examples (never write like these)
1. ❌ "Kuralle is a revolutionary, game-changing platform that empowers you to unlock the full potential of next-generation AI!" — hype, adjectives, zero information.
2. ❌ "In this section, we will endeavor to comprehensively elucidate the manifold capabilities…" — bloated, passive, throat-clearing. Just say what it does.
3. ❌ "Simply just easily add a tool and everything magically works!" — "simply/just/easily/magically" hand-wave; if it's simple, the code shows it.

## Visual Brand Identity
- **Mood:** Clean, technical, high-contrast. Developer-docs aesthetic, not SaaS-marketing gradients.
- **Primary:** deep indigo/violet — `#5B4FE9` (confident, modern, "flow"). Use for links, primary CTAs, the Starlight accent.
- **Secondary:** slate/ink — `#0F172A` (background depth, code surfaces).
- **Accent:** teal/cyan — `#22D3EE` (highlights, active states, diagrams).
- **Code themes:** expressiveCode `houston` (dark) + `one-light` (light), matching the openai-agents-js setup.
- **Typography:** system/Inter for prose; a clean mono (e.g. the Starlight default) for code. Don't fight Starlight's defaults — theme via accent + a light custom CSS, like openai-agents-js does.
- **Logo usage:** wordmark "Kuralle," lowercase-friendly; pair the violet accent on dark.
> Note: colors are a sensible default for the docs accent. If a canonical palette exists elsewhere, that wins — confirm before treating these as final.

## Content Pillars
| Pillar | Description | Example topics |
|--------|-------------|----------------|
| Getting started fast | From install to a running agent in minutes | Quickstart, first agent, first flow |
| The flow model | Procedures as typed graphs | collect/reply/decide, hybrid mode, transitions |
| Production concerns | What makes it survive real traffic | durable tools, sessions, routing, guardrails, safety |
| Text + voice, one agent | Same config across channels | drivers, realtime voice, cascaded voice |
| Deploy anywhere | Multi-runtime story | Hono/Node, Cloudflare Workers, serverless |

## Competitor Landscape
- **OpenAI Agents SDK (JS):** voice anchor + closest peer. Differentiate on **flows** (typed procedure graphs) and **durable tool execution**, not just an agent loop. Never copy their copy verbatim; match the polish, keep our own claims.
- **LangChain / deepagents:** "batteries-included harness." We're lighter and procedure-first; we don't require a graph runtime to start.
- **Voice stacks (LiveKit, Pipecat):** we keep agent authority (tools/flows/handoffs) while using provider-native realtime. Position as "your agent logic, over voice," not a transport library.
- **Voices to NOT mimic:** enterprise "conversational AI platform" marketing; over-hyped launch threads.

## Proof Points
- One tagless primitive (`defineAgent`) derives flow/triage/composition behavior from the fields you set — fewer concepts than peers.
- Real example: a form-filler flow replaces a ~584-line v1 state machine with ~60 lines (`packages/core/examples/agents/form-filler.ts`).
- Durable effect log → exactly-once tool execution across retries.
- 24 packages, one version line; text and voice share the same runtime and agent config.
> Use concrete, verifiable numbers only. If a metric isn't in the repo, don't invent it.

## Content Rules & Guardrails
### Always Do
- Lead with what it does and show working code early.
- Ground every code sample in the **fact-sheet** and a real, runnable file; prefer public imports from `@kuralle-agents/core`.
- State the opinion when there is one (flows vs prompts, structured routing) — briefly, then move on.
- Link sideways (related guide / package) instead of repeating.

### Never Do
- Never use: "revolutionary," "game-changing," "unlock," "empower," "seamless," "magical," "simply/just/easily" as filler, "leverage" (use "use").
- Never document an internal `src/` import path or an unexported symbol as public (see fact-sheet §5).
- Never ship a code sample you haven't typechecked/run.
- Never pad. If a sentence adds no information, cut it.
- Never claim LiveKit native realtime authority (deleted) or any capability not in the code.

### Compliance
- Open-source project: no customer names/metrics we can't cite. MIT-style licensing tone — welcoming, not salesy.
