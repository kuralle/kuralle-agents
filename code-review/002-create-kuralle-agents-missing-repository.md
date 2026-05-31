# 002 — `create-kuralle-agents` missing npm `repository` metadata

| Field | Value |
|-------|-------|
| **Severity** | medium |
| **Axis** | public-API / publishing |
| **Status** | fixed |
| **Location** | `packages/create-kuralle-agents/package.json` |

## What's wrong

The licensing pass (`c5cc61f`) added `license: Apache-2.0` and `repository` to 29 framework packages via regex insertion, but **`create-kuralle-agents`** was missed — it had `license` but no `repository` block.

## Why it fails

npm and GitHub link published packages to source via `repository.directory`. A scaffold CLI without repository metadata is harder to audit, report issues against, and fails consistency checks before a public monorepo flip.

## Evidence

```bash
for d in packages/*/; do
  f="${d}package.json"
  grep -q '"repository"' "$f" || echo "NO REPO: $f"
done
# → NO REPO: packages/create-kuralle-agents/package.json
# (packages/ariaflow-core/ is untracked rename leftover — not published)
```

All other publishable `@kuralle-agents/*` packages include the standard block pointing at `github.com/kuralle/kuralle-agents`.

## Fix applied

Added matching `repository` block with `"directory": "packages/create-kuralle-agents"`.
