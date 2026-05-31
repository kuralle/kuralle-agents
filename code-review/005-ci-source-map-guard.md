# 005 — CI did not run the source-map publish guard

| Field | Value |
|-------|-------|
| **Severity** | low |
| **Axis** | security / publishing |
| **Status** | fixed |
| **Location** | `.github/workflows/ci.yml` |

## What's wrong

Session added `scripts/check-no-source-maps.sh` and wired it into `changeset:publish`, but the new CI workflow only ran `build:packages` + `typecheck:all`. A regression re-enabling `sourceMap: true` or shipping raw `src/` would not fail CI until someone attempted publish.

## Evidence

- `package.json` — `"check:no-source-maps": "bash scripts/check-no-source-maps.sh"`
- Pre-fix: `ci.yml` had no step invoking it
- Guard verified locally: `bash scripts/check-no-source-maps.sh` → `✓ no source maps or raw src in any publishable package tarball`

## Fix applied

Added CI step after build:

```yaml
- name: Verify publish tarballs contain no source maps
  run: bun run check:no-source-maps
```
