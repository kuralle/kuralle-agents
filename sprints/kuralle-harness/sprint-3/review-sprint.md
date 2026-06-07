# Sprint 3 review + proceed — Phase 2: KnowledgeFs over RAG (RFC-03)

**IC:** cursor · **Range:** `f628fac..9e3dd31` (6 commits `kh-S3-C1,C2,C4,C5,C6,C7`; C3=EROFS folded into C1 impl) · **Decision: PROCEED → Sprint 4.**

## Gate 03 results (manager-run, observed)
| Check | Result |
|-------|--------|
| `bun run build` + `typecheck:all` + playground | ✓ green |
| full `bun run test` | 0 fail |
| knowledgefs tests (`knowledgefs`, `-grep`, `-rbac`, `-agent`) | 8 pass / 0 fail, 35 assertions |
| EROFS (C3) | all writes throw (`writeFile/appendFile/mkdir/rm/cp/mv`, KnowledgeFs.ts) |
| RBAC | `accessFilter` (vectorFilter + allowSlug) → `prunePathTree` + query filter (access.ts, KnowledgeFs.ts) |
| **live smoke (observed)** | `KURALLE_EXAMPLE_PROVIDER=openai bun .../examples/support-kb-agent.ts` → agent `grep`'d `/policies/returns.md` + `/support/contact.md` and gave a grounded multi-page answer ("30 days from delivery", "returns@acme.example") |

## Layer 1 — What works
- `KnowledgeFs` implements the core `FileSystem` (read ops) over `VectorStoreCore`; `cat` reassembles chunks by index with per-slug cache; `find/ls/stat` from an in-memory path tree; two-stage `grep` via the `fs.search` coarse hook added to `createFsTool` (core).
- RBAC by tree-pruning + query filter (un-bypassable: pruned slugs absent from tree and queries).
- The headline program use case (support agent over a local KB via grep+cat) is observed working end-to-end.

## Layer 2 — Blockers
- None. Two notes (follow-ups, not blockers):
  1. **Proof-gate script vs schema:** `verify-handoff-proof.sh kh-sprint3` threw `KeyError: 'type'`; the proof JSON itself is substantive (5 `commands_run` with exit codes + validation_contract). Cosmetic; my own gate run is authoritative.
  2. **ADR-0001 tension (cross-cutting):** S3-C4 wired the `workspace` tool into `runCtx.globalTools` (model-visible every turn) so the agent can call it. Safe for read-only KnowledgeFs (writes throw EROFS), but the workspace tool also has `write`/`edit` ops, and ADR-0001 says no *mutating* tools in globalTools. → Program-closeout refinement: make read-only the default for `workspace` visibility (e.g. `workspace?: { fs; readOnly? }`; only auto-expose read-only workspaces, or flow-gate mutation). Logged in WBS risks.

## Verdict
Solid — shipping. Gate 03 GREEN. Advance to Sprint 4.
