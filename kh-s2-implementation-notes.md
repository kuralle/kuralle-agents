# kh-s2 implementation notes

## Decisions

- **FileSystem type in core** (`types/filesystem.ts`), re-exported from `@kuralle-agents/fs` — keeps `AgentConfig.workspace` typed without a core→fs compile cycle; Runtime uses dynamic `import('@kuralle-agents/fs')` plus `kuralle-fs.d.ts` ambient module for core build ordering.
- **One `workspace` tool** with discriminated `op` union (RFC Q3 proposal).
- **`FilePersistentMemoryStore`** documented as Node-only persistent memory blocks, separate from portable `AgentConfig.workspace` (RFC C7 option b).
- **Renamed tree `VNode` → `VEntry`** so `rg "node:"` gate stays clean (property names like `vnode:` matched the pattern).

## Root causes fixed

- Core build failed on `@kuralle-agents/fs` before fs tier exists → ambient module declaration + build tier after core.
- `rg "node:"` false positives from TypeScript `node:` property labels → renamed internal tree types/fields.

## Deviations

- `fs-tool.test.ts` calls `tool.execute` directly (not `CoreToolExecutor`) — `@kuralle-agents/core/tools` subpath does not export effect executor; journal coverage lives in `test:workspace-autoregister`.

## Verification

- `test:inmemoryfs`, `test:fs-tool`, `test:workspace-autoregister`, `test:fs-workers` green
- `bun run build && bun run typecheck:all && bun run test` green
- Live smoke: `bun packages/kuralle-fs/examples/kb-agent.ts`
- `npm pack --dry-run` on `@kuralle-agents/fs`: no `.map`
