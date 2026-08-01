# `@kuralle-agents/build`

Deterministic, non-executing folder compiler for the RFC-0003 agent convention. It emits immutable
Agent Artifacts and a static capability module map. Source modules are parsed, not imported, during
discovery; the deployment bundler imports only the emitted map.

The compiler rejects symlinks, unknown slots, case-folded path collisions, file/depth quotas,
credential-looking values, malformed skill packages, invalid exports, and Node built-ins for a
Cloudflare target.
