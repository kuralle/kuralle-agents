# Story Brief — `S{N}-{nn}` {title}

> **You are the IC engineer (`cursor` worker, default for this project — fresh process for this story; clean context window) with no prior context.** This brief is self-contained. Read it end-to-end before writing any code. If anything in this brief is ambiguous or contradicts what you find on disk, **stop and ask** rather than guess.
>
> **Atomic-commit policy:** when you finish, stage every file you create / modify and commit atomically with `[S{N}-{nn}] {short title}`. Do NOT push. Do NOT make multiple commits per story. Manager handles fix-pass and closeout commits later.

---

## 1. Goal

{One sentence. The verifiable outcome.}

---

## 2. Required reading (in this order)

Read these files **in full** before touching code. They are the contract.

1. `sprints/STATE.md` — current sprint pointer.
2. `sprints/sprint-{N}/PLAN.md` — full sprint plan; find the section for this story.
3. `sprints/WBS.md` § Sprint {N}, story `S{N}-{nn}`.
4. The RFC sections relevant to this story:
   - `rfc/RFC-002-concrete-tech.md` §{X} — {what's there}
   - `wiki/0{X}_*.md` §{Y} — {what's there}
5. The previous sprint's HANDOFF (if any): `sprints/sprint-{N-1}/HANDOFF.md`.
6. {Any story-specific design doc — e.g., `research/RECORDER_DESIGN.md` for recorder stories.}

You may also skim the source repos under `research/{agents-js,cloudflare-agents,langchain-voice-sandwich}/` if the WBS section cites a specific `file:line`.

---

## 3. Files you will create or modify

Be explicit. The reviewer will check that you didn't touch anything else.

**Create:**
- `packages/.../src/...`
- `packages/.../src/...test.ts`
- ...

**Modify:**
- `packages/.../src/...`
- ...

**Do not touch:**
- Anything outside the file list above.
- The RFCs (`rfc/*.md`), wiki (`wiki/*.md`), or research (`research/*.md`) unless this story is explicitly an amendment story — see §6 below.

---

## 4. Acceptance criteria (numbered, in priority order)

These are the gates the reviewer will check. Pass all of them.

1. ...
2. ...
3. ...
4. ...

---

## 5. Definition of Done (universal)

Every box must be ticked before you report back:

- [ ] All acceptance criteria met.
- [ ] Unit tests for every new exported function / class. Behavioral coverage: at least one happy-path and one failure-path test per public surface.
- [ ] CI green on Node 20, Node 22, Bun 1.1+; macOS + Ubuntu (or your local equivalent — list the runtimes you tested).
- [ ] Public TypeScript surfaces match `rfc/RFC-002-concrete-tech.md §6`. **If your work would change a public surface, stop and ask before proceeding.**
- [ ] Telemetry events match `wiki/03_anatomy.md §9.1`.
- [ ] Package README updated for any user-visible change.
- [ ] No `--no-verify`, no `@ts-ignore`, no `try/except: pass`.

---

## 6. What NOT to do

This is anti-scope. The reviewer will reject the diff if you do any of these:

- Do not refactor adjacent code that this story does not require.
- Do not "improve" comments, formatting, or naming outside the changed lines.
- Do not introduce new dependencies without an RFC amendment.
- Do not add features beyond the acceptance criteria.
- Do not rewrite tests that already pass — only add or modify tests for code you touched.
- Do not change the wiki / RFCs unless this story is explicitly an amendment story (see §3 "Modify" — if those files are listed there, you may; otherwise, you may not).
- Do not skip the demo artifact.

---

## 7. Demo artifact

You must produce one of:

- A `.wav` recording (for voice features).
- An `asciinema` cast (for CLI features).
- A screen-recording (for browser / dashboard features).
- A `*.test.ts` snapshot file (for protocol / format features).

Place it under `sprints/sprint-{N}/artifacts/{story}.{ext}` and reference it in your PR description.

---

## 8. How to report back

When you finish:

1. Open a PR titled `[S{N}-{nn}] {short title}`.
2. PR description must include:
   - This story brief link.
   - The DoD checklist with every box ticked.
   - The demo artifact link.
   - The list of files changed.
   - The list of tests added (file:line).
   - One paragraph of "what I considered but didn't do, and why" — the trade-offs you accepted.
3. Tag the PR with `sprint-{N}` and `awaiting-r1-review`.

The reviewer (main session) will then run the sandwich review.

---

## 9. If you get stuck

- If a file path or symbol referenced in this brief does not exist on disk: stop. Report back with what you found and what you expected.
- If the acceptance criteria are mutually contradictory or contradict the RFCs: stop. Report back.
- If a dependency conflict appears: stop. Do not silently downgrade or override.

You are the IC. Sincere work is the only kind we ship. If you didn't run a test, say so. If you couldn't verify an outcome, say so.
