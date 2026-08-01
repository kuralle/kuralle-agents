# Storage ownership and Cloudflare control plane

## Verdict

Keep `DeploymentStore` as the semantic boundary, keep canonical SQL as an explicit first-party
Postgres adapter, and leave schema application to the host application's migration system. For a
Cloudflare Agent with a Hono/Neon backend, use an authenticated control-plane API that returns only
the exact pinned immutable version; keep database credentials and ORM policy out of the Worker.

This is preferable to documenting fields alone because draft compare-and-swap, immutable releases,
tenant isolation, rollout allocation, and atomic first-thread assignment are behavioral invariants.
It is preferable to runtime auto-migration because constructing a library must not mutate an
application-owned database.

## Prior-art findings

Better Auth separates schema generation from migration. Its built-in Kysely adapter supports an
explicit migrate operation, while Prisma and Drizzle users generate schema and run their ORM's
migration tooling. Better Auth also exposes a custom adapter contract and treats schema generation as
an optional adapter capability, not runtime behavior.

Cloudflare maps each Agent instance to a Durable Object with isolated SQLite state. The current
configuration guide recommends declarative Durable Object `exports` for new classes; existing legacy
migration histories remain supported and must not be rewritten. The Flue integration confirms the
platform direction: harness execution maps onto Agent Durable Objects and Agents SDK durability
primitives.

## Decision

- Default Postgres runtime DDL to off; expose reviewed SQL and explicit `migrate()`.
- Do not claim Prisma/Drizzle runtime adapters until they pass the full `DeploymentStore` contract.
- Document raw-SQL migrations inside Prisma/Drizzle as the supported first integration.
- Put definitions/releases in Hono/Neon and thread execution/pins in the Agent DO.
- Resolve exact pins over an authenticated internal API and validate artifact digests at both ends.
- Prefer Hono HTTPS over direct Hyperdrive because it preserves application tenancy and schema
  policy. Use a Cloudflare Service Binding if the Hono control plane is also a Worker.
- Support hosted SaaS with one generic Worker/Agent class. Public agent keys select a definition;
  short-lived launch tokens authorize a tenant/agent/thread; the DO fetches and caches the exact
  pinned artifact for its isolate lifetime and reloads the same version after eviction.

## Flip conditions

- Add ORM-native adapters or generators after a first-party use or three independent integration
  requests, and only with conformance and migration-diff CI.
- Use Hyperdrive directly when the Worker legitimately owns the schema/policy boundary and measured
  cold-bind latency justifies duplicating database access logic.
- Use a Service Binding when both runtime and control plane are in the same Cloudflare account.

## Primary sources

- https://better-auth.com/docs/concepts/database
- https://better-auth.com/docs/concepts/cli
- https://better-auth.com/docs/guides/create-a-db-adapter
- https://github.com/better-auth/better-auth/blob/d8327f1fea92243b6fea1b0ab183e2a989792c0c/packages/cli/src/commands/migrate.ts
- https://developers.cloudflare.com/agents/runtime/operations/configuration/
- https://developers.cloudflare.com/agents/runtime/communication/routing/
- https://developers.cloudflare.com/workers/databases/third-party-integrations/neon/
- https://blog.cloudflare.com/agents-platform-flue-sdk/
