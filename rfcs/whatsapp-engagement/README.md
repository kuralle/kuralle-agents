# RFC: Omnichannel AI customer-engagement on Kuralle flow primitives (WhatsApp · Web · Instagram)

**Category:** New Feature
**Author:** octalpixel
**Date:** 2026-06-01
**Status:** Approved (rev4, 2026-06-01)
**Reviewers:** Codex (rev2 — 8 blockers folded); Cursor (rev3 verification, ran suite 413 pass — 2 blockers + should-fixes folded into rev4)
**Related:** [`CONCEPT.md`](../../CONCEPT.md), [`PRD.md`](../../PRD.md), [`RESEARCH.md`](../../RESEARCH.md)

> Folder name is `whatsapp-engagement` for historical reasons; the feature is **omnichannel** (rev3). The package is `@kuralle-agents/engagement` (channel-agnostic); WhatsApp is the first `ChannelPolicy` adapter.

## Summary

Turn Kuralle into a safe, full-fidelity **omnichannel** agent-engagement engine with proactive outbound. The framework already provides the durable resumable state machine (flows, run/replay, sessions) and a **multi-channel** transport — one `PlatformClient` contract and one `createMessagingRouter({ platforms })` running WhatsApp, Instagram, and web on a single runtime + agents. This RFC adds the missing engagement layer as a channel-agnostic **`@kuralle-agents/engagement`** package + a correct-by-default fix in `@kuralle-agents/messaging`: a window-safe outbound pipeline, a smart closed-window recovery strategist, full interactive fidelity (declare choices once, render per channel) with stable-id inbound routing, a human-handoff ownership gate, consent/opt-out, and broadcasts/drips. Channel differences are isolated behind an injected **`ChannelPolicy`** (window model + `ClosedWindowStrategy` + interactive rendering + consent): **WhatsApp** (24h window + approved-template strategy + Flows), **Web** (null policy — always open, no consent), **Instagram** (24h window + human-agent-tag handoff, quick-replies/carousels). The **same bot** deploys across all three unchanged. Proven on the `multi-platform` example. (Messenger: designed-for, not built this cut.)

**Chosen design (Section 4):** Hybrid — Design A's minimal additive author surface, implemented internally via Design C's outbound-middleware + inbound-resolver-chain pipeline, adopting Design B's discriminated `SendOutcome`/`WindowState` types, with no breaking core-flow changes. (Runner-up designs are recorded as footnotes in [§2](./01-problem-background.md#footnotes).)

## Navigation

| Part | Sections | Contents |
|---|---|---|
| [01-problem-background](./01-problem-background.md) | 1–2 | Problem statement; current state; the 5 verified gaps; design footnotes |
| [02-requirements-interfaces](./02-requirements-interfaces.md) | 3–5 | Strict requirements (REQ-N); the hybrid interface spec; architecture & dependencies |
| [03-pseudocode-blueprint](./03-pseudocode-blueprint.md) | 6–7 | Pseudocode for the pipeline + strategist + inbound resolution; code blueprint |
| [04-tasks-validation](./04-tasks-validation.md) | 8–9 | Incremental task breakdown (safety core → proactive); fail-to-pass + regression tests |
| [05-security-rollback-open-qs](./05-security-rollback-open-qs.md) | 10–12 | Security; rollback/abort; open questions (all resolved) |

## Status

- Open Questions: **6 / 6 resolved** (Section 12 — all carry a committed `**Proposal:**`).
- Adversarial review (Codex, read-only): **8 blockers + 3 should-fixes folded in** as R-01..R-11 — see [§12 Revision notes](./05-security-rollback-open-qs.md#revision-notes-adversarial-review). New **Phase A0** (core seams) added to [§8](./04-tasks-validation.md).
- Scope: conversational engine **+ proactive outbound**. Out: CRM/segments UI, team-inbox UI, analytics dashboards, no-code builder.

## Revision history

- **rev4 (2026-06-01)** — Cursor verification fold-in. Closed 2 spec blockers (R-08-B escalate→human interception via terminal handoff targets / `humanHandoff()` node; IG-CW closed-window tag is text-only, interactive/media defer) + should-fixes (`sendTextOrTemplate` bypass, `BroadcastLedger` interface + atomicity, selection durable-replay, terminal-guard assertion, middleware order, package-name `@kuralle-agents/engagement`, IG interactive mapping to real client methods). See [§12 rev4 notes](./05-security-rollback-open-qs.md#rev4--cursor-verification-fold-in).
- **rev3 (2026-06-01)** — omnichannel re-scope. Package renamed `@kuralle-agents/whatsapp-engagement` → `@kuralle-agents/engagement` (channel-agnostic). Channel differences isolated behind an injected `ChannelPolicy` + `ClosedWindowStrategy`. The strategist generalizes from "pick a WhatsApp template" to "apply the channel's closed-window strategy." Concrete adapters this cut: **WhatsApp** (template strategy), **Web** (null policy), **Instagram** (human-agent-tag / limited proactive). Messenger deferred. The same bot deploys across all channels unchanged.
- **rev2 (2026-06-01)** — adversarial review pass. Corrected the core safety claim (window guard covers all non-template payloads, not just text), added the runtime `selection` propagation seam, inbound type extensions, customer-identity model, pluggable `WindowStore`, explicit broadcast idempotency ledger, and the inbound human-ownership gate. Codex verified `bun test` (413 pass) + `typecheck:all` (green) against the current tree.
- **rev1** — initial draft from `/feature-plan` (PRD + design-an-interface Hybrid selection).
