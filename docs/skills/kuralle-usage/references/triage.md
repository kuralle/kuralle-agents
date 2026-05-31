# Triage (Routing Without Leaks)

## Contents

- Why triage leaks happen
- Structured triage config
- Example triage prompt
- Always-route mode

## Why triage leaks happen

Triage agents are not user-facing. If they speak, the user sees routing logic or handoffs. Avoid this.

## Structured triage config

```jsonc
{
  "runtime": {
    "triageMode": "structured",
    "triageAgent": "triage",
    "alwaysRouteThroughTriage": true
  }
}
```

## Example triage prompt

```md
You are a routing agent. Output only the selected route id.
Never talk to the user.
```

## Always-route mode

Use when each user turn can change route (support vs billing vs incident).
