---
type: verifier
command: bun run typecheck:all
enabled: true
---

# Typecheck and lint

The repo's real gate. `typecheck:all` walks every framework tsconfig, sweeps the
playground configs, checks no raw tool execute reaches the streamText paths, and
runs eslint — so it catches drift the test suite cannot: deleted-API imports in
examples, stale test configs, and type errors in files no test imports.

Exit code 0 means pass.

**Known false red — check this before diagnosing anything else.** `changeset:version`
runs `pnpm install`, which creates a second copy of `agents` under `.pnpm/` alongside
Bun's. `typecheck:all` then fails with a type mismatch between two identical-looking
`TurnQueue` types from different node_modules paths. It is an install artifact, not a
code defect. Fix with `bun install`, then re-run. This has produced a spurious red on
three consecutive releases.
