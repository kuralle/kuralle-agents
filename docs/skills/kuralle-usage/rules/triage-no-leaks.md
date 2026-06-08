# Rule: No Triage Leaks

## MUST

- Use structured triage when routing matters.
- Route internally; never expose routing text.

## MUST NOT

- Let triage agent speak to user.
- Emit handoff language.

## Config

```ts
// Triage = a pure dispatcher: routes/agents only, no answering surface
// (no instructions/flows/tools). It derives a silent model classifier and
// never emits user-facing text — no routing.mode flag needed.
const triage = defineAgent({
  id: 'triage',
  routes: [{ agent: 'support', when: 'general support or anything else' }],
});
```
