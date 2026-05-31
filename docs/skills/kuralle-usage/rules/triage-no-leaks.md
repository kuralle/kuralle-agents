# Rule: No Triage Leaks

## MUST

- Use structured triage when routing matters.
- Route internally; never expose routing text.

## MUST NOT

- Let triage agent speak to user.
- Emit handoff language.

## Config

```jsonc
{
  "runtime": {
    "triageMode": "structured",
    "triageAgent": "triage",
    "alwaysRouteThroughTriage": true
  }
}
```
