# Code Review — Session `e5d469d^..c5cc61f`

Strict review + rectification of the public-readiness / dead-code / G5-G6 session (16 commits, +1129/−1396).

## Kanban

| ID | Severity | Area | Location | Title | Status |
|----|----------|------|----------|-------|--------|
| [001](001-tool-executor-def-precedence.md) | **high** | core / tools | `ToolExecutor.ts:86` | Registry beat explicit flow-local `def` | **fixed** |
| [002](002-create-kuralle-agents-missing-repository.md) | medium | publishing | `create-kuralle-agents/package.json` | Missing npm `repository` metadata | **fixed** |
| [003](003-duplicate-public-readiness-commits.md) | medium | git | `a3fed71`, `c5cc61f` | Duplicate licensing commits | **open** |
| [004](004-sip-udp-integration-flaky.md) | medium | tests / SIP | `sip_signaling_udp_integration.test.ts` | Real-UDP test flaky in full suite | **open** |
| [005](005-ci-source-map-guard.md) | low | CI / security | `.github/workflows/ci.yml` | Source-map guard not in CI | **fixed** |
| [006](006-knip-not-in-ci.md) | low | CI / maintainability | `knip.json` | knip not gated in CI | **open** |
| [007](007-widget-debug-browser-env.md) | low | widget / DX | `widget/src/debug.ts` | Browser debug gate ineffective without bundler define | **open** |
| [008](008-process-docs-in-repo.md) | low | public-readiness | `HANDOFF.md`, `implementation-notes.md` | Internal process docs will ship public | **open** |
| [009](009-g5-g6-local-tools-fix-verified.md) | info | core / voice | drivers + executor | G5/G6 local-tool routing fix sound | verified |
| [010](010-dead-export-dep-prune-verified.md) | info | deps / exports | session cleanup | Dead export/dep prune — no false deletions | verified |

## Fixes applied (working tree, uncommitted)

1. **001** — `args.def ?? this.tools.get(name)` + JSDoc correction in `ToolExecutor.ts`
2. **002** — `repository` block on `create-kuralle-agents/package.json`
3. **005** — `bun run check:no-source-maps` step in CI after build

## Gate verification (post-fix)

### `bun run build:packages`

```
@kuralle-agents/livekit-plugin-transport-sip build: Exited with code 0
@kuralle-agents/livekit-plugin-transport-smartpbx build: Exited with code 0
✓ all packages built (ordered)
```

Exit code: **0**

### `bun run typecheck:all`

```
swept 57 configs; 0 stale-empty
✓ typecheck:all green
swept 7 playground configs; 0 stale-empty
✓ typecheck:playground green
$ eslint 'packages/*/src/**/*.ts' ...
```

Exit code: **0** (ends with `✓ typecheck:all green`)

### `cd packages/kuralle-core && bun test`

```
 362 pass
 0 fail
 534 expect() calls
Ran 362 tests across 50 files. [4.15s]
```

Exit code: **0**

### `bun run check:no-source-maps`

```
✓ no source maps or raw src in any publishable package tarball
```

Exit code: **0**

## Final verdict

**Ready to go public after a short must-fix list** — the session's substantive work (G5/G6 executor routing, analytics source-map leak fix + guard, dead-code/deps cleanup, playground gate, debug gating, licensing) holds up under skeptical review. One **high** defect (tool def precedence) was found and fixed in this pass.

### Must-fix before public (ranked, post-review fixes)

1. **Commit the review fixes** (001, 002, 005) — not yet committed.
2. **Squash duplicate commits** [003] — clean `main` history before first public push.
3. **Owner decisions** [008] — remove or relocate `HANDOFF.md` / `implementation-notes.md`.

### Should-fix (not blocking npm/repo public)

4. **SIP UDP harness** [004] — pre-existing suite flake; CI doesn't run it today.
5. **Wire knip into CI** [006] — prevents dep rot regression.
6. **Widget browser debug** [007] — document or use `import.meta.env`.

### Verified solid (no action)

- G5/G6 flow-local tool architecture [009]
- Dead export/dep deletion discipline [010]
- Analytics SDK tarball clean; `check-no-source-maps` passes
- CI workflow structure (Bun 1.3.9, Rust/napi tier, `--frozen-lockfile`, core-only tests) matches local gates
