# Proceed Evidence — `S4-03` unified 0.4.0 bump + REAL publish

> Manager artifact — Phase A. The release (manager-driven, not delegated — irreversible).

## Story
- **Id:** `S4-03` · **Commit:** `b6c4f25` · **Tag:** `v0.4.0`

## Checklist (manager-executed + verified)
- [x] All **28** publishable packages bumped `0.3.20 → 0.4.0` (manual-version per 0.x+workspace:* gotcha); 2 private (e2e-tests, ws-bench) untouched.
- [x] Internal deps are `workspace:*` (pnpm rewrites to exact at publish) — no piecemeal-pin risk.
- [x] CHANGELOG 0.4.0 breaking note (`part.text → part.delta` + lifecycle; native-realtime advisory; B-06 non-shipping note). `bun install` lockfile synced.
- [x] `build:packages` exit 0; `check-no-source-maps.sh` exit 0 (no `.map`/raw src in tarballs).
- [x] `pnpm publish -r --dry-run` clean: 28 pkgs all @0.4.0, NO `.env`/`.map`/`src` in any tarball, private pkgs excluded.
- [x] **Real `pnpm publish -r --access public` exit 0 — all 28 published.** Verified live: `npm view @kuralle-agents/core version` → `0.4.0` (+ hono-server/livekit-plugin/realtime-audio/cf-agent).
- [x] Tagged `v0.4.0` (`b6c4f25`). npm auth: `octalpixel`.

**Verdict:** `PROCEED` (released)

## One-line
Unified 0.4.0 breaking release — 28 packages live on npm, tag v0.4.0; user-authorized real publish · `b6c4f25`.
