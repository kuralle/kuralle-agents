# 006 — `knip.json` authored but not gated in CI

| Field | Value |
|-------|-------|
| **Severity** | low |
| **Axis** | maintainability |
| **Status** | open |
| **Location** | `knip.json`, `.github/workflows/ci.yml` |

## What's wrong

This session's main dead-code investment (`knip.json`, 0 unused deps/files after config) has no CI enforcement. Export barrels and the unwired `openai-family` subtree can re-accumulate deps without a failing gate.

## Evidence

```bash
grep -r knip .github/workflows/   # → no matches
grep knip package.json            # → no script
```

`implementation-notes.md` D2/D4 documents intentional remaining export flags (45/31).

## Recommendation

Add `"knip": "knip"` root script and a CI job (or step) once the team accepts knip's remaining intentional ignores. Low urgency — framework dep report is clean today.
