# Triage (Routing Without Leaks)

## Contents

- Why triage leaks happen
- Structured triage config
- Example triage prompt
- Always-route mode

## Why triage leaks happen

Triage agents are not user-facing. If they speak, the user sees routing logic or handoffs. Avoid this.

## Structured triage config

```ts
// Triage = a pure dispatcher: routes/agents only, no answering surface
// (no instructions/flows/tools). It derives a silent model classifier and
// never emits user-facing text — no routing.mode flag needed.
const triage = defineAgent({
  id: 'triage',
  routes: [{ agent: 'support', when: 'general support or anything else' }],
});
```

## Example triage prompt

```md
You are a routing agent. Output only the selected route id.
Never talk to the user.
```

## Always-route mode

Use when each user turn can change route (support vs billing vs incident).
