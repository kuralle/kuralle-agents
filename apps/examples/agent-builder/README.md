# Agent Builder

A runnable multi-tenant agent builder: edit an agent in the browser, publish an
immutable version, release it, and chat with the result — with two demo tenants so
the isolation is visible rather than asserted.

Pairs with the [Agent Builder in React](https://agents.kuralle.com/guides/agent-builder-react/)
guide, which explains the reasoning behind each part.

## Run it

```bash
export OPENAI_API_KEY=sk-...

bun run dev        # builder API + agent runtime on :8787
bun run dev:web    # React UI on :5173 (second terminal)
```

Open http://localhost:5173, then: edit the instructions → **Save draft** → **Publish** →
**Send**. Switch the tenant dropdown and repeat to watch the two tenants stay separate.

## What this demonstrates

**Kuralle ships the control-plane model, not a builder API.** Everything under `/api/*`
in `server.ts` is application code you own. The framework supplies `DeploymentStore` and
its invariants: immutable versions, compare-and-swap drafts, sticky thread pins, tenant
isolation. There is deliberately no built-in CRUD for drafts or releases, because every
team's auth, RBAC, and audit differ — while the safety properties must not.

**Save ≠ Publish ≠ Release.** Saving updates a mutable draft. Publishing freezes an
immutable, content-addressed version. Releasing decides what *new* conversations get.
The UI keeps them as three separate actions on purpose.

**Compare-and-swap is the feature.** `saveDraft(draft, expectedRevision)` rejects a stale
write with `CONFLICT`, and the UI surfaces it instead of retrying. Retrying with the new
revision writes stale form state over the change you just detected — last-write-wins with
extra steps.

**`useChat` does not work against the deployment route, and that is not a bug.**
`POST /v1/agents/:id/threads/:threadId/messages` emits Kuralle stream parts as *named*
SSE events (`event: text-delta`) whose `data:` is the payload alone — a different wire
format from the AI SDK UIMessageStream. `web/useDeploymentThread.ts` is the ~40-line
reader, including the two details that bite: buffering across chunk boundaries (a stream
chunk does not respect SSE frame boundaries) and holding one idempotency key across
retries but not across turns.

**Sticky pinning.** A thread pins its version on the first message and keeps it for life,
so a customer mid-conversation is never swapped onto a new prompt. That applies to your
preview pane too, which is why the preview thread id is derived from the published
version — with a **Reset preview thread** button for the rest.

**Tenancy comes from the credential.** `resolvePrincipal` reads the bearer token; the
tenant is never taken from a path segment or request body. Two demo tokens
(`demo-acme`, `demo-globex`) map to two tenants that cannot see each other's agents or
conversations even when they use the same thread id.

## Verified behaviour

Checked against this example running live, with a real model:

| | |
| --- | --- |
| draft save returns an incremented revision | ✅ |
| unauthenticated builder call | `401` |
| stale-revision save | `409`, not last-write-wins |
| published agent answers per its instructions | ✅ |
| missing `idempotency-key` | `400` |
| same thread id, two tenants | each gets its own agent |
| existing thread after a new release | stays on its pinned version |
| new thread after a new release | gets the new version |

## Going to production

This example uses `InMemoryDeploymentStore` and a process-local turn lock so it runs with
no setup. Swap both for real infrastructure:

- **Store** — `PostgresDeploymentStore` or `D1DeploymentStore` (Cloudflare).
- **Turn lease** — `PostgresThreadExecutionCoordinator`, so the one-turn-per-thread rule
  holds across processes rather than within one.
- **Sessions** — a durable `SessionStore` (Redis or Postgres) instead of `MemoryStore`.
- **Auth** — replace the `TOKENS` map with your identity provider.

On Cloudflare, derive the Durable Object name from **tenant and thread**
(`idFromName(`${tenantId}:${threadId}`)`). A thread id is client-supplied and is often a
phone number or email — not unique across your customer base.
