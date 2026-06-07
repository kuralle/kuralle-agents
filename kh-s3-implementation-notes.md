# kh-s3 — implementation notes

## Root causes fixed

1. **Workspace tool invisible to model** — `Runtime` registered `createFsTool` on the executor but not `ctx.globalTools`, so `TextDriver` never passed `workspace` to `streamText`. Fixed by merging `workspace` into `globalTools` at runtime open.

2. **OpenAI invalid tool schema** — `z.discriminatedUnion` for `workspace` input converted to JSON Schema `type: "None"`. Replaced with a flat `z.object` + per-op validation in execute.

3. **Empty `path: ""` from model** — OpenAI fills optional fields with empty strings; grep used `??` not empty-string normalization. Added `normalizeFsPath()` treating blank as `/`.

## Decisions

- **`indexName` required** on `KnowledgeFsOptions` (RFC pseudocode omitted it; store queries need an index).
- **Metadata keys:** `page` + `chunk_index` on vector entry metadata (Mintlify/ChromaFs pattern).
- **`InMemoryVectorStore.listEntries`** — optional scan helper; fallback zero-vector query for other `VectorStoreCore` impls.
- **Coarse grep** — `KnowledgeFs.search()` scans in-memory chunk index (post-init), not a second store round-trip; fine pass remains regex line match in `createFsTool`.
- **RBAC** — tree prune at init + `allowSlug` / `vectorFilter`; traversal via `../` resolves then hits `ENOENT` if pruned.

## Verification

- `test:kfs-*` (8 tests) green
- `bun run build && bun run typecheck:all && bun run test` green
- Live: `KURALLE_EXAMPLE_PROVIDER=openai bun packages/kuralle-rag/examples/support-kb-agent.ts` — grep hits on `/policies/returns.md` + `/support/contact.md`, answer cites 30-day window + returns@

## Commits

Atomic `[kh-S3-C1]` … `[kh-S3-C7]` on `feat/kuralle-harness`.
