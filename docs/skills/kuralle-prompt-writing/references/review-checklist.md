# Prompt Review Checklist

Use this before merging prompt changes.

## Correctness

- Is every factual claim either tool-grounded or explicitly uncertain?
- Are “do not guess” and clarification behaviors explicit?
- Is there a defined fallback path when tools fail?

## Runtime fit

- Does prompt avoid encoding flow logic that belongs in nodes/transitions?
- For triage: does prompt route only (no user-facing response)?
- For flow nodes: is objective atomic and single-step?

## Tool behavior

- Does prompt instruct when to call tools vs when not to?
- Are tool outputs treated as data, not final user prose?
- Are unsafe side effects avoided unless explicitly authorized by tool policy?

## Clarity and token quality

- Are instructions non-contradictory?
- Is prompt short enough to avoid policy dilution?
- Are duplicated rules removed?

## Verification

- Run `kuralle prompt lint --strict` and address all issues.
- Run at least 3 transcripts:
  - happy path
  - tool failure path
  - ambiguous user intent path
- Confirm no routing leaks, no repeated-question loops, and no fabricated facts.
