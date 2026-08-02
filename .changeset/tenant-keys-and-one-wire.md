---
"@kuralle-agents/core": minor
"@kuralle-agents/deployment": minor
"@kuralle-agents/hono-server": minor
"@kuralle-agents/cf-agent": minor
"@kuralle-agents/postgres-store": minor
"@kuralle-agents/cli": patch
---

Isolate threads per tenant, and serve one UIMessageStream wire from every runtime.

**Tenant isolation.** A thread id is client-supplied and the tenant is not, so two tenants using the same string — a phone number on the WhatsApp path — shared one session, one version pin, and one execution lease. Storage keys are now composed at the deployment boundary via `scopedKey`, which is injective by length-prefixing so no pair of `(tenant, thread)` can collide by concatenation. The composed key never crosses the wire: a client gets its own thread id back as `messageMetadata.sessionId`.

**One wire.** `cf-agent`'s `StreamAdapter` hand-rolled a second `StreamPart` → UI mapping that dropped `id` on text frames, used a `data-*` namespace no `KuralleUIMessage` client matched, defaulted tool arguments off, and had no case at all for `interactive`, `safety-blocked`, `paused` or `conversation-outcome` — approvals and safety blocks were structurally unreportable on Cloudflare. It is deleted; every runtime serves `harnessToUIMessageStream`, and an unmapped client variant now fails the build rather than vanishing at runtime.

**Reconciliation ids.** `data-kuralle-handoff`, `-safety` and `-outcome` carried random ids, and clients reconcile a data part on `(type, id)` — so a re-emitted turn appended duplicates instead of updating in place. They now carry a stable per-turn ordinal.

BREAKING CHANGES

- `@kuralle-agents/cf-agent` no longer exports `createSSEResponse`, `StreamAdapterConfig` or `DEFAULT_STREAM_CONFIG`, and the `getStreamConfig()` hook is gone. Core's mapping is unconditional by design; delete any override — with the base method removed it silently configures nothing.
- Cloudflare deployments now emit `data-kuralle-*` parts. Clients matching `data-handoff`, `data-flow-enter`, `data-flow-node`, `data-flow-transition`, `data-flow-end` or `data-error` must be updated.
- `POST /v1/agents/:agentEntityId/threads/:threadId/messages` returns an AI SDK `UIMessageStream` by default. Non-browser consumers that parsed named-event `StreamPart` SSE must append `?format=raw`.
- `AgentRelease.state` is removed. Rollout state is derived from allocations.
- Existing pin, lease and session rows are keyed by thread id alone and must be migrated to the composite key. Postgres: `PostgresDeploymentStore.migrate()`. Cloudflare D1 and session stores: the migration helpers shipped in this release, including `rekeySessionsByTenant`.
