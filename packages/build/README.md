# `@kuralle-agents/build`

Deterministic, non-executing folder compiler for the RFC-0003 agent convention. It emits immutable
Agent Artifacts and a static capability module map. Source modules are parsed, not imported, during
discovery; the deployment bundler imports only the emitted map.

An agent folder's `flows/` slot may hold `.ts`/`.tsx` modules or top-level `*.flow.json` files;
`kuralle build` validates each JSON `FlowDefinition` and embeds it inline in the artifact's `flows`
slot alongside the compiled module references.

Files that cannot be inlined are retained as content-addressed build blobs. The CLI writes those
bytes to `blobs/<sha256>` and embeds them into self-contained host bundles; binders verify byte count
and digest again when content is loaded.

The compiler rejects symlinks, unknown slots, case-folded path collisions, file/depth quotas,
credential-looking values, malformed skill packages, invalid exports, and Node built-ins for a
Cloudflare target.
