# Story Brief — `S0-01` Scaffold `@kuralle-agents/engagement`

> **You are the IC engineer (`cursor` worker — fresh process, clean context, no prior context).** This brief is self-contained. Read it end-to-end before writing any code. If anything is ambiguous or contradicts what you find on disk, **stop and ask** — do not guess.
>
> **Atomic-commit policy:** when finished, stage every file you created/modified and commit atomically with `[S0-01] Scaffold @kuralle-agents/engagement` on **`plan/whatsapp-engagement`** (the current branch — confirm with `git branch --show-current`). Do NOT push. Do NOT checkout `main`. One commit for this story.
>
> **Runtime:** this repo uses **Bun** for dev/build. Use `bun` / `bun run`, not npm, except where a single-package build is invoked (`cd packages/kuralle-engagement && npm run build` is fine — it just runs `tsc`).

---

## 1. Goal

Create a new publishable workspace package `@kuralle-agents/engagement` at `packages/kuralle-engagement/` (ESM, NodeNext, strict), with an empty `src/index.ts` (no behavior yet), wired into the Bun workspace and the topological build so that `bun run build` builds it and `bun run typecheck:all` sweeps it — both green.

---

## 2. Required reading (in this order)

1. `sprints/STATE.md` — sprint pointer + build branch (must be `plan/whatsapp-engagement`).
2. `sprints/sprint-0/PLAN.md` § Story `S0-01` and § 0 (Decisions made before briefing — **the package is `@kuralle-agents/engagement` at `packages/kuralle-engagement/`**, per REQ-22; ignore the stale `whatsapp-engagement` names in RFC §4.4/§5.1).
3. `sprints/WBS.md` § Sprint 0, story `S0-01`.
4. **Scaffold reference (mirror this package's shape exactly):**
   - `packages/kuralle-messaging/package.json`
   - `packages/kuralle-messaging/tsconfig.json`
   - `packages/kuralle-messaging/src/index.ts` (just to see the export style; yours will be near-empty)
5. **Build wiring:** `scripts/build-packages.sh` (you will add `engagement` to a tier) and `scripts/typecheck-tsconfigs.sh` (auto-discovers tsconfigs — no edit needed, just understand it sweeps your new package).
6. Root `package.json` (workspaces glob is `packages/*` — your package matches automatically).
7. `CLAUDE.md` (repo root) — "No source maps (`.map`) in published tarballs"; publish-together rule.

---

## 3. Files you will create or modify

**Create:**
- `packages/kuralle-engagement/package.json`
- `packages/kuralle-engagement/tsconfig.json`
- `packages/kuralle-engagement/src/index.ts`
- `packages/kuralle-engagement/README.md`

**Modify:**
- `scripts/build-packages.sh` — add `engagement` to the **T3 tier** (the line that already lists `... hono-server cf-agent livekit-plugin messaging-meta`). Append `engagement` to that tier's argument list. (It depends only on `core` today but will depend on `messaging`/`messaging-meta` in later sprints; T3 is race-safe and future-proof.)
- Lockfile via `bun install` (`bun.lockb` — this is expected and fine to commit).

**Do not touch:**
- Anything outside the list above. No edits to `core`, `messaging`, or other packages. No RFC/WBS/wiki edits.

---

## 4. Concrete specifications

### 4.1 `package.json` — mirror `kuralle-messaging`, with these values

```jsonc
{
  "name": "@kuralle-agents/engagement",
  "license": "Apache-2.0",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/kuralle/kuralle-agents.git",
    "directory": "packages/kuralle-engagement"
  },
  "version": "0.0.0",
  "description": "Channel-agnostic engagement layer for Kuralle agents (window-safe outbound, smart-send, interactive fidelity, handoff, consent, proactive).",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "publishConfig": { "access": "public" },
  "files": ["dist", "README.md"],
  "scripts": {
    "prebuild": "rm -rf dist",
    "build": "tsc -p tsconfig.json",
    "clean": "rm -rf dist",
    "test": "bun test",
    "prepublishOnly": "npm run clean && npm run build"
  },
  "dependencies": {
    "@kuralle-agents/core": "workspace:*"
  },
  "devDependencies": {
    "typescript": "^5.8.2",
    "@types/node": "^22.13.4"
  }
}
```

> **Note:** Do NOT add `@kuralle-agents/messaging` as a dependency in this story — `S0-04` adds it when the policy seam needs it. S0-01 depends on `core` only.

### 4.2 `tsconfig.json` — copy `kuralle-messaging/tsconfig.json` verbatim

It already has: `target: ES2022`, `module/moduleResolution: NodeNext`, `strict: true`, `declaration: true`, `declarationMap: false`, `sourceMap: false`, `noFallthroughCasesInSwitch: true`, `outDir: ./dist`, `rootDir: ./src`, `include: ["src/**/*"]`. Use the same.

### 4.3 `src/index.ts` — near-empty

```ts
// @kuralle-agents/engagement — channel-agnostic engagement layer.
// Public surface is added incrementally per the Sprint plan (S0-04 ships the
// ChannelPolicy seam + webPolicy). Intentionally empty in S0-01.
export {};
```

### 4.4 `README.md` — one short paragraph

A few lines: what the package is (channel-agnostic engagement layer per RFC `whatsapp-engagement` REQ-22), status (scaffold — surface lands incrementally across the sprint roadmap), and a pointer to `rfcs/whatsapp-engagement/`. Keep it brief.

### 4.5 `scripts/build-packages.sh`

Find the `tier ... messaging-meta` line (T3). Append `engagement` to its arguments so the tier builds it after `core`. Do not reorder other tiers.

---

## 5. Acceptance criteria (the gates the manager checks)

1. `packages/kuralle-engagement/package.json` exists with the values in §4.1 (name `@kuralle-agents/engagement`, ESM, exports map, scripts, `core` dep only).
2. `packages/kuralle-engagement/tsconfig.json` mirrors `kuralle-messaging` (NodeNext, strict, no source maps).
3. `src/index.ts` exists and is near-empty (no runtime behavior).
4. `scripts/build-packages.sh` includes `engagement` in the T3 tier.
5. `cd packages/kuralle-engagement && npm run build` produces `dist/index.js` AND `dist/index.d.ts`, and produces **no `.map` files** (`ls dist` shows none).
6. From repo root: `bun install` succeeds; `bun run build` is green and builds engagement in order; `bun run typecheck:all` is green.

---

## 6. What NOT to do

- No behavior/logic in `src/` — pure scaffold.
- Do not add `messaging` (or any) dependency beyond `core`.
- Do not edit other packages, RFCs, WBS, or the typecheck scripts.
- Do not enable source maps.
- Do not push or touch `main`. One atomic commit.

---

## 7. Validation contract (required in proof)

Copy these assertion IDs into `proof-s0-01.json` `validation_contract.assertions_required`:
- `cmd:build` — `bun run build` exits 0 and engagement is built
- `cmd:typecheck_all` — `bun run typecheck:all` exits 0
- `file:dist_js` — `packages/kuralle-engagement/dist/index.js` exists
- `file:dist_dts` — `packages/kuralle-engagement/dist/index.d.ts` exists
- `cmd:no_source_maps` — `find packages/kuralle-engagement/dist -name '*.map'` returns empty (exit 0, no output)

### Proof commands

| claim_id | command | satisfies_assertions |
|----------|---------|----------------------|
| build | `bun run build` | cmd:build |
| typecheck | `bun run typecheck:all` | cmd:typecheck_all |
| dist-js | `test -f packages/kuralle-engagement/dist/index.js` | file:dist_js |
| dist-dts | `test -f packages/kuralle-engagement/dist/index.d.ts` | file:dist_dts |
| no-maps | `sh -c '[ -z "$(find packages/kuralle-engagement/dist -name "*.map")" ]'` | cmd:no_source_maps |

`assertions_satisfied` must equal `assertions_required` (set equality) for the manager to accept.

---

## 8. Proof artifact (REQUIRED — `delegate-proof-schema` v1)

Write `.handoff/proof-s0-01.json` (schema_version 1) with: `slug: "s0-01"`, `worker`, `git_sha` (the commit you make), `rfc_path: "rfcs/whatsapp-engagement/"`, `chunk_id: "A0"`, the `validation_contract` above, `commands_run[]` (full audit incl. any failed attempts), and `claims[]` mapping each to `satisfies_assertions`. For each verification command, write a stdout sidecar `.handoff/proof-s0-01-<claim_id>.stdout` and put its `sha256` in the claim. Then write the sentinel:

```bash
echo "DONE $(git rev-parse HEAD) proof=.handoff/proof-s0-01.json" > .handoff/result-s0-01.done
```

If stuck: `echo "STUCK <reason>" > .handoff/result-s0-01.done` and do not fabricate a proof.

---

## 9. Demo artifact

Capture combined output to `sprints/sprint-0/artifacts/s0-01-build.txt`:
```bash
mkdir -p sprints/sprint-0/artifacts
{ echo "### bun run build"; bun run build; echo; echo "### ls dist"; ls -la packages/kuralle-engagement/dist; echo; echo "### typecheck:all (tail)"; bun run typecheck:all | tail -8; } > sprints/sprint-0/artifacts/s0-01-build.txt 2>&1
```
Commit it as part of the story.

---

## 10. How to report back

Report: files created/modified, the commit sha, the proof slug (`s0-01`), the DoD checklist ticked, the demo artifact path, and one paragraph of trade-offs you accepted. Do NOT open a PR (this project commits to the build branch directly; the manager handles review). Ensure `.handoff/proof-s0-01.json` + `.handoff/result-s0-01.done` are written.

---

## 11. If you get stuck

- If a referenced file/symbol does not exist: stop, report what you found vs expected.
- If `bun run build` or `typecheck:all` fails for a reason outside your package (pre-existing breakage): stop and report — the baseline was green before this story, so a failure should trace to your change.
- No `--no-verify`, no `@ts-ignore`, no silent catches. Sincere work only — if you didn't run a check, say so.
