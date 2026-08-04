# marketing-team

A Kuralle port of [`vercel-labs/marketing-team-eve-template`](https://github.com/vercel-labs/marketing-team-eve-template),
verified live end to end against a real model and a real database (task b7-verify).

A marketing lead agent grounds itself in a shared brand-context document, then routes each
request to whichever of five specialists owns it: **product marketer** (positioning, owns the
brand context), **content marketer** (blog posts, landing pages, newsletter prose),
**email** (adapts copy for the inbox, operates the email channel), **social media coordinator**
(X, LinkedIn, Threads, Bluesky, Mastodon drafts), and **SEO** (page and site audits, schema
markup, programmatic SEO). Every specialist carries its own [skills](agent/) — packaged
Markdown playbooks plus reference files (banned-words lists, format specs, checklists) loaded
on demand — and writes back to Postgres through a shared, tenant-scoped tool surface
(`agent/lib/`).

Unlike the original template, this port is self-contained: every external SaaS dependency is
replaced by local Postgres, so it runs with no third-party accounts beyond a model API key.

## What this example demonstrates

- **Routing, not orchestration in the model's head.** The lead's `routes` + `routing` (a
  natural-language classifier over each specialist's `when` clause) is the whole dispatch
  mechanism — no `routing.mode`, no client-visible "let me route this to…" narration.
- **Tenant isolation enforced at the tool boundary, not in the prompt.** No tool input schema
  ever declares a `workspaceId` field; every tool resolves its scope from `ctx` through one
  seam (`agent/lib/workspace-scope.ts`), so a workspace id can never arrive as caller-supplied
  input. `test/schema.db.test.ts` and `test/tools/isolation.test.ts` pin this with two
  workspaces sharing a colliding slug.
- **Policy denying a tool outright, not a prompt asking nicely.** Every specialist except
  product-marketer gets `policy: readOnlyPolicy(['save_brand_context'])` — the one agent
  allowed to write the shared brand document is enforced structurally, the same property this
  repo's design rules ask for everywhere else.
- **Skills as packaged, on-demand context**, not one giant system prompt: each specialist loads
  only the skill a task actually needs (`content-planning` vs `content-editing` vs
  `writing-quality`), via `@kuralle-agents/build`'s `packageSkillsDirectory`.
- **Durable tools with audit trails.** Every write is transactional and paired with an
  append-only revision row (`brand_context_revisions`, `content_revisions`) recording who
  changed what — `authored_by_agent` / `edited_by_agent` / `created_by_agent` on every table.
- **A live, scripted, multi-hop proof** (`scripts/e2e.ts`) that the whole chain actually works
  against a real model and Postgres — not just that it typechecks and its unit suite is green.
  See "How this was verified" below.

## One-command setup

```bash
cp .env.example .env               # set OPENAI_API_KEY (or another provider's key)
docker compose up -d --wait        # starts Postgres on localhost:5433
bun install
bun run db:migrate
bun run dev:server                 # Hono server (agents, tools, REST) on :4001
bun run dev                        # Next.js frontend on :3000, proxying to it
```

The web app never talks to Postgres directly and never sees `DATABASE_URL` — it proxies every
`/api/*` call to the standalone Hono server (`web/next.config.ts`), because the agent runtime
reads its instructions and skills off disk with a Bun-only API (`import.meta.dir`) a bundler
can't resolve. Run the two processes side by side, as above.

## Schema map

| Table | What it is | Written by |
| --- | --- | --- |
| `workspaces` | The tenant. Everything else scopes to one row here. | seed / first request |
| `brand_context` + `brand_context_revisions` | The one shared positioning document every specialist reads first; revisions are append-only history. | `product-marketer` only (policy-enforced) |
| `content_pieces` + `content_revisions` | The Notion replacement — blog posts, landing pages, case studies, newsletters (draft prose), social drafts, email pieces. One row per piece, `kind` distinguishes them. | `content-marketer`, `email`, `social-media-coordinator`, or a human via the web editor |
| `artifacts` | Handoff payloads one specialist saves for another to read by id (an SEO audit, a newsletter draft, a competitive-research scan) — kept out of the lead's own context. | any specialist with `save_artifact` |
| `assets` | Uploaded file bytes on local disk (gitignored `storage/`), metadata in Postgres — the Vercel Blob replacement. | any specialist with asset tools |
| `user_preferences` | Standing workflow notes ("always draft for X and LinkedIn") the lead keeps per person, distinct from brand context. | `lead` |
| `campaign_links` | The tracked-link (UTM) vocabulary. | any specialist with `build_tracked_link` |
| `social_posts` | Modeled as the Typefully replacement (surface, body, schedule, status) — **migrated and tenant-indexed, but no tool writes to it.** See "What the port taught us." | *(nothing, currently)* |
| `email_sends` | Modeled as the Resend replacement (subject, recipients, send status) — **migrated and tenant-indexed, but no tool writes to it.** Same gap as above. | *(nothing, currently)* |

## Kuralle primitives this example exercises

| Primitive | Where |
| --- | --- |
| `defineAgent` with `routes` + `routing` (triage) | `agent/lead.ts` |
| `defineAgent` as an answering/free-conversation agent | every specialist under `agent/*/agent.ts` |
| `defineTool` — durable, transactional, tenant-scoped | `agent/lib/*/tools.ts` |
| `policy` / `readOnlyPolicy` — deny a tool at the boundary | every specialist except product-marketer |
| Skills (`packageSkillsDirectory`, own + shared) | every specialist; `agent/shared/skills/writing-quality` is loaded by four of the five |
| `createRuntime` / `runtime.run()` / `TurnHandle.events` | `server/runtime.ts`, `scripts/e2e.ts` |
| `tracing` (`TracingConfig`, `MemoryTraceStore`) | `scripts/e2e.ts` — asserts on handoff and tool-call spans, never on reply text |
| `toUIMessageStreamResponse` | `server/api.ts`'s `/api/chat` route, consumed by `web/components/ChatPanel.tsx` via `@ai-sdk/react`'s `useChat` |

## What was deliberately replaced from the original template, and why

The original template wires four hosted SaaS products directly into the agent tool surface.
Requiring four accounts (plus API keys, plus rate limits, plus separate failure domains) to run
a *framework example* works against the one thing an example is for — running it. Every
replacement below keeps the same job the original tool did, backed by one local Postgres
instance instead:

| Original | Replaced by | Why |
| --- | --- | --- |
| Vercel Blob | `assets` table + local disk (`agent/lib/assets/tools.ts`) | File bytes belong next to the metadata that describes them; no separate storage account to provision. |
| Notion | `content_pieces` + `content_revisions` | A relational table with an audit trail is a better fit for "one piece, many revisions, tenant-scoped" than a page tree, and it's queryable in the same transaction as everything else. |
| Typefully | `content_pieces` (`kind: "social"`) | Drafting and queue-keeping; see the `social_posts` gap noted above for the part that was modeled but never wired. |
| Resend | `content_pieces` (`kind: "email"`) | Adapting and preparing a send; see the `email_sends` gap for the same reason. Every specialist's instructions say plainly that there is no live send integration in this deployment — an instruction naming a tool that doesn't exist teaches the model to hallucinate a call, so this was written to be explicit rather than silent. |
| `resend-build` (the original template's Resend-flavored email-markup build step) | Dropped entirely | With no Resend integration, there is nothing for a Resend-specific build step to target; `email/skills/email-style` carries the actual formatting rules (600px container width, plain-text pairing, etc.) as portable guidance instead. |

## How this was verified

Four gates, each run against a live model and a live Postgres, all green:

```bash
bun test ./test/                              # 122 unit/integration tests
bun run typecheck                              # from repo root
bun run --cwd apps/examples/marketing-team build
bun run e2e                                    # scripts/e2e.ts — see below
```

`scripts/e2e.ts` is the live scenario: seed a workspace, ask the lead for positioning work
(routes to product-marketer, which writes the brand context), ask for a blog post (routes to
content-marketer, which reads the brand context and creates a content piece), read that piece
back out of Postgres and check `body_json`/`body_markdown` are populated and structurally
consistent, ask for a newsletter (the two-hop chain: content-marketer saves an artifact, email
reads it back by id and adapts it), ask for social posts, ask for an SEO audit. Every assertion
checks the **database** or the **run trace** (handoff events, tool-call arguments) — never reply
prose, which is not a contract the model owes you.

```bash
docker compose down -v && docker compose up -d --wait && bun run db:migrate
bun run e2e
```

Run twice against a freshly recreated volume, both green, before this task was called done —
a scenario that only passes on a database carrying yesterday's rows proves nothing.

Set `E2E_PROVIDER=xai` (with `XAI_API_KEY` set) to run the scenario against xAI instead of the
OpenAI default — see the note in `scripts/e2e.ts`.

## What the port taught us

Findings from actually running the chain live, not from reading the code:

- **`authored_by_agent` was misattributing every specialist's first write to `lead` (fixed).**
  `agent/lib/workspace-scope.ts#actingAgent` read `ctx.session.currentAgent`, which the Kuralle
  runtime only updates once a whole turn closes. A handoff updates
  `ctx.runState.activeAgentId` synchronously, before the target's own tools run — so any tool a
  specialist called during the SAME turn it was routed into (which, given how routing works
  here, is every specialist's first call, always) recorded the audit column as the agent that
  routed it, not the agent that did the work. Verified live: a `create_content` call from
  content-marketer landed `authored_by_agent = 'lead'`; switching `actingAgent` to read
  `runState.activeAgentId` fixed it. This is an app-level fix (`agent/lib/workspace-scope.ts`);
  the underlying `session.currentAgent`-lags-`runState.activeAgentId` timing is a Kuralle
  runtime property worth documenting there too.
- **`lint_against_style`'s surface enum was missing `"email"` (fixed).** `email/skills/` ships
  an `email-style` skill specifically for this, and email's own instructions say to run
  `lint_against_style` on every draft — but the `surfaces` tuple both `server/runtime.ts` and
  this script built the tool from never included `"email"` as a legal enum value. Live effect:
  the email specialist, needing to lint email copy, had no correct surface to pick and thrashed
  through `x`, `linkedin`, and `blog` (none of which it has skills for) before giving up with an
  empty reply. Fixed in `server/runtime.ts` and `scripts/e2e.ts`.
- **`social_posts` and `email_sends` are dead schema.** Both tables are migrated and
  tenant-indexed (`test/schema.db.test.ts` checks a `workspace_id` index on each), but no tool
  anywhere in `agent/lib/` writes to either — both specialists' own, reviewed instructions state
  plainly that a `content_pieces` status change "is the end of what this tool surface does."
  Brief b7-verify's scripted scenario originally expected rows in `social_posts`; that
  expectation and the shipped behavior disagree. Not resolved by picking a side silently
  (workmanship rule 12) — flagged here for a human call: either wire the missing tools, or drop
  the tables.
- **No research/fetch capability exists anywhere in the stack**, despite four of five
  specialists' instructions describing one at length (`seo`'s instructions describe `web_fetch`
  in detail — what it returns, its limits with client-rendered content, when to trust it;
  `product-marketer`, `content-marketer`, and `social-media-coordinator` all describe "search
  for it, open the page, quote what it says"). There is no `web_fetch` tool, or any tool with a
  similar name, anywhere in this app or in `packages/core`, and the runtime is built with no
  `HarnessConfig.tools` supplying one either. A specialist asked to research something it wasn't
  handed directly has no way to, and — per its own instructions, which are written to be honest
  about this — will say so rather than fabricate a source. This is a framework-level gap (a
  reusable, SSRF-guarded fetch/search tool belongs in `packages/core` or a shared package, not
  reimplemented per app) rather than something to patch here; `scripts/e2e.ts` works around it
  by giving every specialist everything it needs directly in the brief, never asking one to
  fetch a live URL.
- **A one-way handoff cannot chain two specialists within one user turn.** The lead's own
  instructions describe the newsletter flow as "call the first, wait, put its output in the
  second's brief" — but a Kuralle handoff (via `routes`, `handoffs`, or `agents[]`; all three
  resolve through the same one-way `transfer_to_agent` control tool) permanently transfers
  control to the target for the rest of the run. Specialists here carry no `routes`/`handoffs`
  of their own, so nothing can hand control back to the lead, or on to a third agent, within a
  single turn. Confirmed by tracing `Runtime.ts`'s turn loop: `activeAgentId` is reassigned in
  place the moment a handoff fires, and the loop only continues into the TARGET's own hostLoop —
  there is no call-and-return. A further consequence: once a conversation thread is routed to a
  specialist, `session.currentAgent` stays pinned to it for every future turn on that session id
  (`web/components/ChatPanel.tsx` mints exactly one `conversationId` per browser session), so a
  natural two-step ask across two chat messages in the SAME thread ("write it" — routes away from
  lead — then "now email it") has no path back to the lead's router either. `scripts/e2e.ts`
  reproduces the newsletter flow faithfully by playing the orchestrator itself: two
  lead-addressed turns on two different session ids, glued by the artifact id read back from
  Postgres, exactly the way a human operator (or a smarter client) would have to.
- **Postgres jsonb does not preserve object key order.** A first version of the `body_json` /
  `body_markdown` consistency check in `scripts/e2e.ts` compared `JSON.stringify` output and
  failed on every real run, even though nothing was actually wrong — jsonb reordered a node's
  keys (`{"text":...,"type":"text"}` on read vs. `{"type":"text","text":...}` on write) in a
  structurally identical document. Fixed by comparing structurally (a small `deepEqual`) instead
  of by serialized string. Worth remembering for any future jsonb round-trip check in this repo.
- **Live model behavior varies enough to need a nudge, not a single fixed prompt.** One
  gpt-4.1-mini run, given a complete positioning brief, answered by stuffing the whole brief into
  `save_user_preferences` (the wrong tool — that's for standing workflow prefs, not the shared
  brand document) and replying "I've saved the brand context," without ever calling
  `save_brand_context` or routing to product-marketer — a live, reply-text-lied-about-what-happened
  case for why this task's own rule ("reply text is not a contract") matters. A differently
  worded brief on the next attempt routed correctly first try. `scripts/e2e.ts` handles this by
  driving up to three turns per step (the brief, then up to two nudges) and asserting against the
  database and the union of trace events across all of them — never against a single turn, and
  never against what the model said it did.
