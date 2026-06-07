# Sprint 2 review + proceed — Phase 1: FileSystem primitive (RFC-02)

**IC:** cursor · **Range:** `d08ae54..fc6adee` (8 IC commits `kh-S2-C1..C8` + 1 manager fix `kh-S2-fix`) · **Decision: PROCEED → Sprint 3.**

## Gate 02 results (manager-run, observed)
| Check | Result |
|-------|--------|
| proof gate | `PROOF_OK` (11 claims, 16 assertions) |
| `bun run build` + `typecheck:all` + playground | ✓ green |
| full `bun run test` | 0 fail |
| `fs-workers.test.ts` (vitest-pool-workers) | ✓ pass (workerd parity) |
| portability | `grep node: packages/kuralle-fs/src/{interface,in-memory-fs,path-utils,encoding,tool}.ts` → empty |
| `AgentConfig.workspace` auto-register | ✓ (live smoke below) |
| **live smoke (observed)** | `KURALLE_EXAMPLE_PROVIDER=openai bun packages/kuralle-fs/examples/kb-agent.ts` → `workspace` tool executed `ls` (dir tree), `read` (file content), `grep` (hit with path/line/text) over InMemoryFs |

## Layer 1 — What works
- Portable `FileSystem` interface + `InMemoryFs` in `@kuralle-agents/fs`, zero `node:*`; interface declared in `kuralle-core/src/types/filesystem.ts` (one-directional graph). `RunContext.fs` threaded; `AgentConfig.workspace?: FileSystem` (agentConfig.ts:53).
- `createFsTool` covers ls/cat/grep/find/read/write/edit with structured returns; readOnly → EROFS; ENOENT/EISDIR handled.
- C7 reconciled the orphaned `FilePersistentMemoryStore` (documented vs `workspace`).

## Layer 2 — Blockers (found + fixed by manager)
- **Circular `core↔fs` dependency + dynamic `await import('@kuralle-agents/fs')` + hand-maintained ambient `.d.ts`.** The IC's tests were green but the wiring violated the project no-dynamic-imports rule and RFC-02 §5.2 (no core→fs dep). Root cause: `createFsTool` was placed in the fs package, but auto-register needs it from core. Fix (`kh-S2-fix`): moved `createFsTool` into `core/src/tools/fs/createFsTool.ts` (needs only `defineTool` + `FileSystem`, both core-owned), static import in `Runtime.ts`, removed `@kuralle-agents/fs` from `core/package.json` (peerDep + meta + devDep), deleted the dead `kuralle-fs.d.ts`, and `@kuralle-agents/fs` now re-exports `createFsTool` from core. Re-verified: typecheck:all + test green, core tsc clean, live smoke green.

## Verdict
Solid (after manager fix). Gate 02 GREEN. Advance STATE to Sprint 3. The createFsTool-in-core decision supersedes RFC-02 §4.3's file-placement detail (honors §5.2's no-core→fs-dep constraint) — noted for RFC accuracy.
