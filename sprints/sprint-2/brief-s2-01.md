# Story Brief — `S2-01` B1: SmartSendStrategist + guardrails

> **You are the IC engineer (`cursor` worker — fresh process, clean context).** Self-contained. Read end-to-end before coding. Ambiguity/contradiction with disk → **stop and ask**.
>
> **Atomic-commit:** finish → `[S2-01] B1 SmartSendStrategist + guardrails` on **`plan/whatsapp-engagement`**. No push, no `main`, one commit.
>
> **Runtime:** Bun. `bun test`.

---

## 1. Goal

Implement `createSmartSendStrategist` in `@kuralle-agents/engagement`: deterministic guardrails OUTSIDE the AI (window-open short-circuit → `catalog.approved()` filter → `selector.select` → `catalog.validateParams` → `audit.record` → `template`; any failure → `defer`). Replace the `TODO(S2-01)` placeholder. Proven by `strategist_filters_paused_templates`, `strategist_defers_on_bad_params`, `strategist_audits_conversion`, `window_open_no_selector_call`.

---

## 2. Required reading (in this order)

1. `sprints/STATE.md`; `sprints/sprint-2/PLAN.md` § Story `S2-01` + § 0.
2. RFC: `02-requirements-interfaces.md` **§4.4** (the interface signatures), **REQ-4/5/6**; `03-pseudocode-blueprint.md` **§6.2** (the exact decide() flow).
3. Source:
   - `packages/kuralle-engagement/src/policy.ts` — the `SmartSendStrategist` **placeholder** (`decide(input: unknown): Promise<unknown>`, `TODO(S2-01)`) you replace; `ClosedWindowStrategy{kind:'template', strategist}` references it; `ChoiceOption` (leave as-is).
   - `packages/kuralle-messaging/src/types/outbound.ts` — `OutboundTemplate` (S2-02 makes it component-aware; here just import it), `WindowState` (re-exported from messaging; or import from `@kuralle-agents/messaging`).
   - `packages/kuralle-engagement/src/index.ts` — export the strategist + types.
   - Test pattern: `packages/kuralle-engagement/test/web-policy.test.ts` (bun:test style).

> Engagement depends on `@kuralle-agents/messaging` + `@kuralle-agents/core` (added S0-04). `bun run build` first.

---

## 3. Concrete interfaces (define in `packages/kuralle-engagement/src/strategist.ts`)

The RFC §4.4 lists the core signatures; `StrategistInput` and `ConversionAudit` are under-specified there — use these concrete shapes (a gap-fill, not a divergence):

```ts
import type { OutboundTemplate, WindowState } from '@kuralle-agents/messaging';

export interface TemplateDescriptor {
  name: string;
  language: string;
  category: 'authentication' | 'marketing' | 'utility';
  status: 'APPROVED' | 'PENDING' | 'REJECTED';
  quality: 'GREEN' | 'YELLOW' | 'RED' | 'PAUSED' | 'DISABLED' | 'UNKNOWN';
  params: { key: string; required: boolean }[];
}

export type DeferReason =
  | 'no-approved-template' | 'no-template-fit' | 'param-validation-failed'
  | 'selector-error' | (string & {});

export interface ConversionAudit {
  requestedText: string;
  chosenTemplate: string;
  params: Record<string, string>;
  at: number; // epoch ms
}

export type SendDecision =
  | { kind: 'freeform'; text: string }
  | { kind: 'template'; template: OutboundTemplate; selected: TemplateDescriptor; audit: ConversionAudit }
  | { kind: 'defer'; reason: DeferReason };

export interface StrategistInput {
  text: string;                 // the requested free-form text
  window: WindowState;
  intent?: string;
  flowState?: Readonly<Record<string, unknown>>;
}

export interface TemplateSelector {
  select(input: {
    text: string;
    intent?: string;
    candidates: readonly TemplateDescriptor[];
    flowState?: Readonly<Record<string, unknown>>;
  }): Promise<{ name: string; language: string; params: Record<string, string> } | null>;
}

export interface TemplateCatalog {
  approved(): Promise<TemplateDescriptor[]>;
  validateParams(name: string, p: Record<string, string>): { ok: boolean; errors?: string[] };
}

export interface AuditSink {
  record(a: ConversionAudit): Promise<void> | void;
}

export interface SmartSendStrategist {
  decide(input: StrategistInput): Promise<SendDecision>;
}

export function createSmartSendStrategist(opts: {
  catalog: TemplateCatalog;
  selector: TemplateSelector;
  audit: AuditSink;
}): SmartSendStrategist;
```

### `decide` logic (§6.2 — guardrails OUTSIDE the AI)
```
if (input.window.open) return { kind:'freeform', text: input.text };   // REQ-6: NO selector call
const candidates = await catalog.approved();                            // guardrail (a): APPROVED + non-paused only
if (candidates.length === 0) return { kind:'defer', reason:'no-approved-template' };
let pick;
try { pick = await selector.select({ text: input.text, intent: input.intent, candidates, flowState: input.flowState }); }
catch { return { kind:'defer', reason:'selector-error' }; }            // selector throw/timeout → defer, never block
if (pick == null) return { kind:'defer', reason:'no-template-fit' };
const v = catalog.validateParams(pick.name, pick.params);              // guardrail (b)
if (!v.ok) return { kind:'defer', reason:'param-validation-failed' };
const selected = candidates.find(c => c.name === pick.name)!;          // (must be an approved candidate)
const audit: ConversionAudit = { requestedText: input.text, chosenTemplate: pick.name, params: pick.params, at: Date.now() };
await audit.record(audit);                                             // guardrail (d): audit BEFORE returning template
const template: OutboundTemplate = { name: pick.name, language: pick.language, namedParams: pick.params };
return { kind:'template', template, selected, audit };
```
*(If `pick.name` is not among `candidates`, treat as `no-template-fit` defer — never trust the selector to stay in-set.)*

---

## 4. Files

**Create:** `packages/kuralle-engagement/src/strategist.ts` (interfaces above + `createSmartSendStrategist`).
**Modify:** `packages/kuralle-engagement/src/policy.ts` — replace the placeholder `SmartSendStrategist` with `import type { SmartSendStrategist } from './strategist.js'` (delete the stub interface + its `TODO(S2-01)`); keep `ClosedWindowStrategy{kind:'template', strategist: SmartSendStrategist}` working. `packages/kuralle-engagement/src/index.ts` — export the strategist surface.
**Create:** `packages/kuralle-engagement/test/strategist.test.ts`.

**Do not touch:** `messaging`/`messaging-meta` (S2-02 does the catalog/selector impls + type extensions). No middleware/node wiring (S2-03). Do not make `OutboundTemplate` component-aware here (S2-02).

---

## 4b. Acceptance criteria

1. `createSmartSendStrategist` + all §3 interfaces exist and are exported; `policy.ts` placeholder replaced (no `TODO(S2-01)` left; `engagement` builds).
2. Window-open ⇒ `{kind:'freeform'}` with **zero** `selector.select` calls.
3. Closed + empty `approved()` ⇒ `defer:'no-approved-template'`; selector null ⇒ `defer:'no-template-fit'`; selector throws ⇒ `defer:'selector-error'`; `validateParams` false ⇒ `defer:'param-validation-failed'`.
4. Closed + valid pick ⇒ exactly one `audit.record` call, then `{kind:'template'}` with `selected` + `audit`.
5. The strategist only ever passes `catalog.approved()` candidates to the selector (PAUSED/REJECTED never reach it — they're filtered by the catalog; assert the candidates the mock selector receives contain no PAUSED/REJECTED).
6. Tests pass: `strategist_filters_paused_templates`, `strategist_defers_on_bad_params`, `strategist_audits_conversion`, `window_open_no_selector_call`. Use a mock catalog (in-memory `TemplateDescriptor[]`) + mock selector (records call count + returns a scripted pick/null/throw) + mock audit (records calls).
7. `bun run build` + `bun run typecheck:all` green; `bun test packages/kuralle-engagement` green.

---

## 5. What NOT to do
- No concrete `aiTemplateSelector`/`whatsappTemplateCatalog` (S2-02) — only the interfaces + the strategist logic, exercised with mocks.
- No `strategistMiddleware`/`smartSend` (S2-03).
- Do not extend `OutboundTemplate`/`TemplateInfo` (S2-02).
- No `any`, `@ts-ignore`, `--no-verify`, silent catch (the selector try/catch → `defer` is the documented failure mode, not a silent swallow).

---

## 6. Validation contract (`.handoff/proof-s2-01.json`)
`assertions_required`: `REQ-5`, `REQ-6`, `test:strategist_filters_paused_templates`, `test:strategist_defers_on_bad_params`, `test:strategist_audits_conversion`, `test:window_open_no_selector_call`, `cmd:typecheck_all`.

| claim_id | command | satisfies_assertions |
|----------|---------|----------------------|
| strat-test | `bun test packages/kuralle-engagement/test/strategist.test.ts` | REQ-5, REQ-6, test:strategist_filters_paused_templates, test:strategist_defers_on_bad_params, test:strategist_audits_conversion, test:window_open_no_selector_call |
| eng-suite | `bun test packages/kuralle-engagement` | REQ-5 (regression) |
| typecheck | `bun run typecheck:all` | cmd:typecheck_all |

### PROOF SCHEMA CHEAT-SHEET (follow exactly)
- `claims[].type` ∈ **`test_suite` | `typecheck` | `lint` | `http` | `custom_command` | `ui_recording` | `file_exists`** only (`bun test`→`test_suite`, `typecheck:all`→`typecheck`).
- Each claim: **`id`** (NOT `claim_id`) = sidecar basename (`id:"strat-test"` → `.handoff/proof-s2-01-strat-test.stdout`); plus `stdout_sidecar`, `command`, `cwd`, `exit_code`, `stdout_sha256`, `satisfies_assertions`.
- Each `commands_run[]` row: `purpose` = literal `"verification"`; `claim_id` matches a `claims[].id`.
- `assertions_satisfied` == `assertions_required`. Sentinel: `echo "DONE $(git rev-parse HEAD) proof=.handoff/proof-s2-01.json" > .handoff/result-s2-01.done`.

---

## 7. Demo artifact
`sprints/sprint-2/artifacts/s2-01-tests.txt` — the 4 named tests + typecheck tail. Commit it.

## 8. Report back
Files changed, commit sha, proof slug `s2-01`, DoD ticked, demo path, trade-offs (esp. the `StrategistInput`/`ConversionAudit` shapes you finalized). **No root `*-implementation-notes.md`.** No PR.

## 9. If stuck
- The placeholder removal must not break `policy.ts`'s `ClosedWindowStrategy` — wire the import correctly.
- Baseline green pre-story. No shortcuts.
