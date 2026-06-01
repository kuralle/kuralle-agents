# Story Brief — `S2-02` B2: TemplateSelector + WhatsApp catalog + component-aware OutboundTemplate

> **You are the IC engineer (`cursor` worker — fresh process, clean context).** Self-contained. Read end-to-end. Ambiguity → **stop and ask**.
>
> **Atomic-commit:** `[S2-02] B2 TemplateSelector + catalog + component-aware OutboundTemplate` on **`plan/whatsapp-engagement`**. No push/`main`, one commit. **Bun.**

---

## 1. Goal

Supply the concrete `TemplateSelector` (AI, mockable) and a WhatsApp-backed `TemplateCatalog` (filters APPROVED + non-paused, cached); extend `TemplateInfo` with `quality?`/`paused?` (R-10); make `OutboundTemplate` component-aware with a **channel-neutral** component type. Proven by `catalog_filters_approved_nonpaused`, `catalog_caches_approved`.

---

## 2. Required reading
1. `sprints/STATE.md`; `sprints/sprint-2/PLAN.md` § Story `S2-02` + § 0.
2. RFC `02-requirements-interfaces.md` **§4.4** (TemplateSelector/TemplateCatalog/TemplateDescriptor), **REQ-5**; `05-security-rollback-open-qs.md` **R-10** (component-aware; TemplateInfo lacks quality/paused).
3. Source:
   - `packages/kuralle-engagement/src/strategist.ts` — `TemplateSelector`, `TemplateCatalog`, `TemplateDescriptor` interfaces (created S2-01). Import them; provide impls.
   - `packages/kuralle-messaging/src/types/outbound.ts` — `OutboundTemplate` (S1-01); add `components?` with a NEUTRAL component type.
   - `packages/kuralle-messaging-meta/src/whatsapp/types.ts` — `TemplateInfo` (~367; add `quality?`/`paused?`), `TemplateComponent` (~110), `TemplateMessage` (~92).
   - `packages/kuralle-messaging-meta/src/whatsapp/client.ts` — `templates.list(wabaId): Promise<TemplateInfo[]>` (~463, `GET {wabaId}/message_templates`) — the catalog's data source; `sendTemplate(to, TemplateMessage)` (~268).
   - `packages/kuralle-messaging-meta/src/whatsapp/templates.ts` — builder helpers (`buildTemplateSendPayload`); add a neutral→Meta mapping helper here if needed.
   - For the AI selector: the repo uses Vercel AI SDK (`ai` pkg, `generateObject`/`generateText`). Check an existing AI call in the repo (e.g. `grep -rn "generateObject\|generateText" packages/kuralle-core/src | head`) for the import + model-passing style. The selector takes a `LanguageModel` (from `ai`).

> `bun run build` first (S2-01's `strategist.ts` must be in dist).

---

## 3. Files & specs

**Modify `packages/kuralle-messaging/src/types/outbound.ts`** — add a neutral component type + extend `OutboundTemplate` (additive):
```ts
/** Channel-neutral template component (R-10). Maps to the platform's native shape at the sink. */
export interface OutboundTemplateComponent {
  type: 'header' | 'body' | 'button';
  /** Positional parameter values for this component. */
  params?: string[];
  subType?: string;  // e.g. 'quick_reply' | 'url' (buttons)
  index?: number;    // button index
}
// OutboundTemplate gains:  components?: OutboundTemplateComponent[];
```
Do NOT import any WhatsApp type into `messaging`.

**Modify `packages/kuralle-messaging-meta/src/whatsapp/types.ts`** — `TemplateInfo` gains:
```ts
  /** Quality rating (Meta `quality_score.score`), when available. */
  quality?: string;   // e.g. 'GREEN' | 'YELLOW' | 'RED'
  /** Whether the template is paused due to quality. */
  paused?: boolean;
```
Populate from the list response where present (the Meta `message_templates` payload may include `quality_score`/`status` fields — map defensively; absent ⇒ leave undefined). If `templates.list` maps the raw response, extend that mapping; if it passes raw through, map in the catalog.

**Create `packages/kuralle-engagement/src/catalog.ts`** — `whatsappTemplateCatalog({ client, wabaId }): TemplateCatalog`:
- `approved()`: lazily fetch `await client.templates.list(wabaId)` ONCE, **cache** the mapped result; map each `TemplateInfo` → `TemplateDescriptor` (`status` mapped to the `'APPROVED'|'PENDING'|'REJECTED'` union; `quality` mapped to the descriptor's quality union, default `'UNKNOWN'`; `params` derived from components/body placeholders or `[]` if not derivable); **filter** to `status==='APPROVED'` AND not paused (`paused !== true` AND `quality` not in `{'PAUSED','DISABLED'}`).
- `validateParams(name, params)`: look up the cached descriptor by name; check every `required` param key is present in `params`; unknown extra keys → `ok:false` with `errors`. If the template isn't found → `{ok:false, errors:['unknown template']}`.
- `client` is typed against the minimal surface you need (`{ templates: { list(wabaId): Promise<TemplateInfo[]> } }`) — import `WhatsAppClient`/`TemplateInfo` from `@kuralle-agents/messaging-meta` (engagement may depend on messaging-meta — add it to `package.json` if not already; `bun install`).

**Create `packages/kuralle-engagement/src/selector.ts`** — `aiTemplateSelector(model: LanguageModel): TemplateSelector`:
- `select({ text, intent, candidates, flowState })`: prompt the model to pick the best-fit template name + language + params from `candidates` (pass candidate names/params), returning `{name, language, params}` or `null` if none fit. Use the Vercel AI SDK (`generateObject` with a small zod schema is cleanest). Keep it minimal — the determinism/guardrails are the strategist's job (S2-01); the selector only proposes.
- It may throw/time out — that's fine; the strategist (S2-01) catches → `defer`. (You MAY add an internal timeout, but not required.)

**Modify `packages/kuralle-engagement/src/index.ts`** — export `whatsappTemplateCatalog`, `aiTemplateSelector`, `OutboundTemplateComponent` (re-export from messaging if helpful).
**Modify `packages/kuralle-engagement/package.json`** — add `@kuralle-agents/messaging-meta: workspace:*` if not present; `bun install`.

**Create tests:** `packages/kuralle-engagement/test/catalog.test.ts` — use a **mock client** `{ templates: { list: async () => [<TemplateInfo fixtures>] } }`:
- `catalog_filters_approved_nonpaused`: fixtures include an APPROVED non-paused template (included), a PENDING/REJECTED (excluded), and an APPROVED-but-`paused:true` or `quality:'PAUSED'` (excluded). Assert `approved()` returns only the good one.
- `catalog_caches_approved`: a counting mock `list` — call `approved()` twice → `list` invoked exactly once.
- (Optional) a `validateParams` happy/failure pair.
The AI selector gets a **shape/smoke** test only (mock the model or assert the function exists + returns the right type with a stub model) — the real selection is mocked in S2-01's strategist tests.

**Do not touch:** the strategist logic (S2-01), `strategistMiddleware`/`smartSend` (S2-03), the pipeline/router.

---

## 4. Acceptance criteria
1. `OutboundTemplate.components?: OutboundTemplateComponent[]` added (neutral; no WA import in `messaging`). S1 fields unchanged.
2. `TemplateInfo` gains optional `quality?`/`paused?`; populated where the Meta response provides them.
3. `whatsappTemplateCatalog` filters APPROVED + non-paused, maps to `TemplateDescriptor`, and **caches** `approved()`; `validateParams` checks required params.
4. `aiTemplateSelector(model)` implements `TemplateSelector`; mockable; may throw (strategist handles).
5. Tests `catalog_filters_approved_nonpaused` + `catalog_caches_approved` pass.
6. `bun run build` + `typecheck:all` green; `bun test packages/kuralle-engagement packages/kuralle-messaging-meta` green.

## 5. What NOT to do
- No WA type import into `messaging` (neutral component only).
- No strategist/middleware/node changes (S2-01/S2-03).
- Don't wire the catalog/selector into the pipeline yet (S2-03).
- No `any`, `@ts-ignore`, `--no-verify`, silent catch.

## 6. Validation contract (`.handoff/proof-s2-02.json`)
`assertions_required`: `REQ-5`, `test:catalog_filters_approved_nonpaused`, `test:catalog_caches_approved`, `cmd:typecheck_all`.

| claim_id | command | satisfies_assertions |
|----------|---------|----------------------|
| catalog-test | `bun test packages/kuralle-engagement/test/catalog.test.ts` | REQ-5, test:catalog_filters_approved_nonpaused, test:catalog_caches_approved |
| eng-suite | `bun test packages/kuralle-engagement` | REQ-5 (regression) |
| meta-suite | `bun test packages/kuralle-messaging-meta` | REQ-5 (TemplateInfo extension non-breaking) |
| typecheck | `bun run typecheck:all` | cmd:typecheck_all |

### PROOF SCHEMA CHEAT-SHEET (follow exactly)
- `claims[].type` ∈ **`test_suite` | `typecheck` | `lint` | `http` | `custom_command` | `ui_recording` | `file_exists`** only.
- Each claim: **`id`** (NOT `claim_id`) = sidecar basename (`.handoff/proof-s2-02-<id>.stdout`); plus `stdout_sidecar`, `command`, `cwd`, `exit_code`, `stdout_sha256`, `satisfies_assertions`.
- `commands_run[]` `purpose` = literal `"verification"`; `claim_id` matches a `claims[].id`. `assertions_satisfied` == `assertions_required`. Sentinel `echo "DONE $(git rev-parse HEAD) proof=.handoff/proof-s2-02.json" > .handoff/result-s2-02.done`.

## 7. Demo artifact
`sprints/sprint-2/artifacts/s2-02-tests.txt` — catalog tests + typecheck tail.

## 8. Report back
Files, commit sha, proof slug `s2-02`, DoD, demo path, trade-offs (esp. how `quality`/`paused` map from the Meta list response, and the `params` derivation for `TemplateDescriptor`). **No root `*-implementation-notes.md`.** No PR.

## 9. If stuck
- If the Meta `message_templates` response shape (via `graphApi.get`) doesn't expose `quality`/`paused`, model them optional + populate where present; **flag in your report** if paused-detection is impossible from the available data (don't fake it).
- Baseline green pre-story. No shortcuts.
