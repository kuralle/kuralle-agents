# Story Brief (Second Opinion, r2) — `S{N}-{nn}` {title}

> **You are a second-opinion reviewer (`codex` worker).** The IC who wrote the diff(s) was a `cursor` worker; the spec + code-quality gate was run by a `pi` worker; the manager (main session) wrote r1. You are deliberately a fourth, independent voice. Your job is **NOT** to redo the work. Your job is to find what r1 + the gate missed, and to act as the strongest spec + quality + adversarial gate before the manager fix pass.
>
> **Sprint-level usage (default):** when this brief is reused for sprint-level review, §1 inputs list every story brief + every IC commit + the pi gate report + r1 review. The structure of the review you write is the same; the scope is one sprint's worth of diff, not one story.

---

## 1. Context

**Story:** `S{N}-{nn}` — {title}.

**Inputs to your review:**
1. The original story brief: [`sprints/sprint-{N}/brief-{story}.md`](../brief-{story}.md).
2. The IC worker's diff: PR #{N} (or local branch `sprint-{N}/S{N}-{nn}`).
3. The first review (r1) by the main session: [`sprints/sprint-{N}/review-{story}-r1.md`](../review-{story}-r1.md).

Read all three. Read the diff in full, line by line.

---

## 2. Your job

Find what r1 missed.

**Look for non-obvious issues:**
- Race conditions, especially around `AbortSignal` propagation, `Promise.race`, and worker-thread message ordering.
- Edge cases not exercised by tests (zero-length input, simultaneous events, end-of-stream during interruption).
- Threading-model assumptions that break on Bun vs Node.
- Memory leaks: unbounded queues, event-listener leaks (`once: true` missing), `WeakMap` misuse.
- Type-safety holes: `any`, `as unknown as`, unsafe array access, missing discriminated-union exhaustiveness.
- Untested code paths: every `catch` should be testable; every `if/else` branch should be reachable in tests.
- Hidden coupling: a module that imports from another that wasn't supposed to be a dependency.
- Latency regressions: a new `await` added on a hot path; a `JSON.parse` of a large payload per frame.
- Security concerns: injection, log poisoning, secrets in errors.
- Wire-protocol drift: any change to the WebSocket protocol without a `VOICE_PROTOCOL_VERSION` bump.
- Bundle bloat: a new transitive dep that pulls in something heavy.

**Critique r1 itself if it's wrong.** If r1 praised something that's actually broken, call it out. If r1 marked something `minor` that should be `major`, call it out. You are an adversarial second opinion; pretend the first reviewer is overconfident.

**Look for what's not there.**
- Missing tests.
- Missing telemetry events the spec requires.
- Missing README updates.
- Missing demo artifact.

---

## 3. What NOT to do

- Do not rewrite the IC's code. Your output is a review document, not a code change.
- Do not litigate style choices that don't violate a spec rule (no bikeshedding).
- Do not duplicate the praise from r1 — assume the reader has already read r1.
- Do not invent rules. Every critique must cite an RFC § / wiki § / DoD line / language-spec rule.

---

## 4. Output

Write `sprints/sprint-{N}/review-{story}-r2.md` from the template at `sprints/templates/REVIEW-r2.md`.

Your verdict at the end is one of:

- **Endorse r1.** r1 caught everything; nothing additional to add. (Rare. If you reach this, double-check — r2's job is to be skeptical.)
- **Strengthen r1.** r1 was substantially right; here are additional items.
- **Override r1.** r1 missed a blocker or upgraded a critique that should have been downgraded (or vice-versa). Name the disagreement explicitly.

---

## 5. Tone

Senior, calm, evidence-based. No mockery. No hedging. If a critique is right, say "this is a blocker because X" — not "perhaps this could be reconsidered."

You are the second line of defense before merge. The story does not ship until every blocker and major item from both reviews is resolved.
