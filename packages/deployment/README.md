# `@kuralle-agents/deployment`

Workerd-safe contracts for publishing immutable agent artifacts, assigning weighted releases, and
pinning a thread to one agent/runtime revision pair.

This package contains no host, database, or filesystem adapter. `InMemoryDeploymentStore` is a
reference implementation for local development and adapter conformance tests. Production adapters
must preserve its immutability, tenant isolation, and atomic create-or-read thread semantics.

See [RFC 0003](../../rfcs/0003-agent-revisions-and-production-deployment.md).
