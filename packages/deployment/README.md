# `@kuralle-agents/deployment`

Contracts and production adapters for publishing immutable agent artifacts, assigning weighted
releases, and pinning a thread to one agent/runtime revision pair.

The root export is workerd-safe and includes the canonical artifact schema, binder, registries,
embedded content resolver, compatibility checks, and in-memory conformance store. Platform exports:

- `@kuralle-agents/deployment/node` — persistent-volume artifact content and isolated thread workspaces;
- `@kuralle-agents/deployment/cloudflare` — D1 control plane and R2 artifact content resolver.

Published versions are append-only. An active release controls assignment only for a thread without
a pin; an existing pin never follows a later release. The binder verifies artifact bytes, runtime API
compatibility, capability versions, tenant identity, workspace provisioning, and deployment trace
identity before execution.

See [the deployment guide](../../docs/guides/file-agent-deployment.md) and
[RFC 0003](../../rfcs/0003-agent-revisions-and-production-deployment.md).
