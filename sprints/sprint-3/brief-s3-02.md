# Story Brief — `S3-02` C2: interactiveRenderer middleware + limits (R-11)

> **IC engineer (`cursor`, fresh process).** Self-contained. Ambiguity → **stop and ask**.
> **Atomic-commit:** `[S3-02] C2 interactiveRenderer + limits` on **`plan/whatsapp-engagement`**. No push/`main`, one commit. **Bun.**

## 1. Goal
An `interactiveRenderer` `OutboundMiddleware` (engagement) that consumes the `{type:'interactive'}` stream part from `req.meta.parts`, renders `ChoiceOption[]` → buttons(≤3)/list(≤10)/cta/Flow as an `InteractiveMessage`, rewrites the payload to `{kind:'interactive', interactive}`, and **rejects over-limit with an explicit error (no silent slice)**. Proven by `render_picks_buttons_then_list`, `renderer_rejects_over_limit`.

## 2. Required reading
1. `sprints/sprint-3/PLAN.md` § Story `S3-02` + § 0.
2. RFC `02-requirements-interfaces.md` **§4.6** (the part the middleware consumes), **REQ-7**; `03-pseudocode-blueprint.md` **§6.4** (renderInteractive on node entry → middleware consumes the part); `05-...` **R-11** (reject, no silent slice).
3. Source:
   - `packages/kuralle-messaging/src/types/messages.ts` — `InteractiveMessage` (96-114: `{type:'buttons'|'list'|'flow'; body; action}`); `InteractiveAction` (buttons: `{type:'buttons', buttons:{id,title}[]}`; list: `{type:'list', button, sections:[{title, rows:{id,title,description?}[]}]}`; flow: `{type:'flow', flowId, flowToken?, parameters?}`).
   - `packages/kuralle-core/src/types/stream.ts` — the `{type:'interactive'; nodeId; options; prompt}` variant (S3-01) + `ChoiceOption` (now in core, S3-01).
   - `packages/kuralle-messaging/src/types/outbound.ts` — `OutboundMiddleware`, `OutboundRequest`, `OutboundPayload`, `OutboundNext`, `SendOutcome`.
   - `packages/kuralle-engagement/src/policies/web.ts` — `webPolicy.renderInteractive` maps `ChoiceOption[]`→buttons (no limit check) — your renderer is the limit-enforcing, list-capable version.
   - WhatsApp limits reference: `packages/kuralle-messaging-meta/src/whatsapp/client.ts` ~340 (silently slices today — you must NOT; throw instead).

> `bun run build` first (S3-01's stream variant + core `ChoiceOption` in dist).

## 3. Specs
**Create `packages/kuralle-engagement/src/interactive-renderer.ts`:**
- `renderChoices(options: ChoiceOption[], prompt: string): InteractiveMessage` — pure function:
  - if any option has `flow` ⇒ a `{type:'flow', ...}` InteractiveMessage (single Flow CTA).
  - else if any option has `url` ⇒ a cta-style message (map to the closest `InteractiveMessage` shape available; if the InteractiveMessage union has no dedicated cta, use buttons with a url-bearing action or document the mapping).
  - else if `options.length <= 3` ⇒ `{type:'buttons', body:prompt, action:{type:'buttons', buttons: options.map(o=>({id:o.id, title:o.label}))}}`.
  - else if `options.length <= 10` ⇒ `{type:'list', body:prompt, action:{type:'list', button:'Choose', sections:[{title:'Options', rows: options.map(o=>({id:o.id, title:o.label, description:o.description}))}]}}`.
  - else (`> 10`) ⇒ **throw** `new Error('interactive: too many options (max 10 list rows)')`.
  - Validate label lengths (WhatsApp: button title ≤20 chars, list row title ≤24) ⇒ **throw** an explicit error on violation (cite the limit). No silent truncation.
- `interactiveRenderer(): OutboundMiddleware` — name `'interactive-renderer'`:
  ```
  async send(req, next) {
    const part = req.meta.parts.find(p => p.type === 'interactive');
    if (!part) return next(req);
    const interactive = renderChoices(part.options, part.prompt);   // throws on over-limit
    return next({ ...req, payload: { kind: 'interactive', interactive } });
  }
  ```
  Installed before the terminal `windowGuard` (via `config.outbound`), like `strategistMiddleware`.

**Modify** `engagement/src/index.ts` — export `interactiveRenderer`, `renderChoices`.
**Create** `engagement/test/interactive-renderer.test.ts`.

**Do not touch:** the stream variant (S3-01), the inbound resolver (S3-03), `withChoices` (S3-04), the WA client.

## 4. Acceptance criteria
1. `interactiveRenderer()` middleware rewrites payload to `{kind:'interactive', interactive}` when an interactive part is present; passes through otherwise.
2. `renderChoices`: ≤3 ⇒ buttons; 4..10 ⇒ list; `url` ⇒ cta; `flow` ⇒ Flow; **>10 or over-length label ⇒ throws** (explicit, no slice).
3. Tests `render_picks_buttons_then_list` (3⇒buttons type, 6⇒list type with 6 rows) + `renderer_rejects_over_limit` (11 options throws; a >20-char button title throws).
4. `bun run build` + `typecheck:all` green; `bun test packages/kuralle-engagement` green.

## 5. What NOT to do
- No silent slice/truncation — throw.
- No WA-client edit, no resolver/withChoices.
- No `any`, `@ts-ignore`, `--no-verify`, silent catch.

## 6. Validation contract (`.handoff/proof-s3-02.json`)
`assertions_required`: `REQ-7`, `test:render_picks_buttons_then_list`, `test:renderer_rejects_over_limit`, `cmd:typecheck_all`.

| claim_id | command | satisfies_assertions |
|----------|---------|----------------------|
| render-test | `bun test packages/kuralle-engagement/test/interactive-renderer.test.ts` | REQ-7, test:render_picks_buttons_then_list, test:renderer_rejects_over_limit |
| eng-suite | `bun test packages/kuralle-engagement` | REQ-7 (regression) |
| typecheck | `bun run typecheck:all` | cmd:typecheck_all |

### PROOF SCHEMA CHEAT-SHEET (follow exactly)
- `claims[].type` ∈ **`test_suite`|`typecheck`|`lint`|`http`|`custom_command`|`ui_recording`|`file_exists`** only.
- Each claim: **`id`** (NOT `claim_id`) = sidecar basename (`.handoff/proof-s3-02-<id>.stdout`) + `stdout_sidecar`, `command`, `cwd`, `exit_code`, `stdout_sha256`, `satisfies_assertions`.
- `commands_run[]` `purpose`=`"verification"`; `claim_id` matches a `claims[].id`. `assertions_satisfied`==`assertions_required`. Sentinel `echo "DONE $(git rev-parse HEAD) proof=.handoff/proof-s3-02.json" > .handoff/result-s3-02.done`.

## 7. Demo artifact
`sprints/sprint-3/artifacts/s3-02-tests.txt` — named tests + typecheck tail. **`git add` it.**

## 8. Report back
Files, commit sha, proof slug `s3-02`, DoD, demo, trade-offs (esp. the cta mapping if `InteractiveMessage` has no dedicated cta shape). **No root `*-implementation-notes.md`.** No PR.

## 9. If stuck
- If `InteractiveMessage` can't represent a cta/url button cleanly, map url options to a buttons action and document; flag if it can't be represented at all.
- Baseline green pre-story. No shortcuts.
