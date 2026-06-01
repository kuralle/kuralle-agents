# Review (r2, second opinion) — Sprint {N} (or `S{N}-{nn}` {title} for one-off out-of-loop stories)

> **Reviewer (`codex` worker):** {model + timestamp}.
> **Scope:** sprint-level by default — diff under review is `git log --oneline {prior-sprint-head}..HEAD` across every story commit + the manager's fix-pass commit (if applied before r2 ran). Per-story scope only when the manager runs a one-off story outside the sprint loop.
> **Inputs:** the spec + code-quality gate report (`gate-sprint.md`) and the manager's r1 review (`review-sprint-r1.md`).

---

## 1. Endorsement / disagreement with r1

Pick one and justify in one paragraph:

- **Endorse r1.** {Why — what r1 caught that you would have caught.}
- **Strengthen r1.** {What r1 caught is correct, but here's what r1 missed.}
- **Override r1.** {Where r1 was wrong; cite the rule and the file:line.}

---

## 2. What r1 missed

This is the load-bearing section. Use the categories from the brief.

### 2.1 Concurrency / race conditions

- **{title}** at `path/to/file.ts:line`. Severity: ... . Why r1 missed it: ... . Proposed fix: ...

### 2.2 Edge cases not tested

- **{title}** at `path/to/file.ts:line`. Severity: ... .

### 2.3 Threading-model assumptions (Bun vs Node)

- ...

### 2.4 Memory / resource leaks

- ...

### 2.5 Type-safety holes

- ...

### 2.6 Untested code paths

- ...

### 2.7 Hidden coupling / dependency violations

- ...

### 2.8 Latency regressions

- ...

### 2.9 Security concerns

- ...

### 2.10 Wire-protocol drift

- ...

### 2.11 Bundle bloat / transitive dependency surface

- ...

### 2.12 Missing artifacts (tests, telemetry, README, demo)

- ...

For categories that genuinely have nothing to add, write "Nothing to add — r1 covered this." Do not pad.

---

## 3. Critique of r1 itself

Did r1 miscategorize a severity? Praise something that's broken? Reject something that should have been accepted?

- **{Where in r1}**: r1 said {X}; r1 was wrong because {Y}. Cite RFC § / wiki § / DoD line.

If r1 was right on every count, write "r1 was correct on every item I checked." That is also valid.

---

## 4. Cross-cutting

Anything that doesn't fit a single line or file but emerged from reading the whole diff:

- ...

---

## 5. Verdict

Pick one:

- [ ] **Endorse r1.** Diff is mergeable once r1's items resolve.
- [ ] **Strengthen r1.** Diff has additional items I found; merge blocked until items below resolve.
- [ ] **Override r1.** Disagree with r1 on a blocking item; main session must adjudicate.

List the items the main session must resolve before the story is closed (in order):

1. ...
2. ...
3. ...
