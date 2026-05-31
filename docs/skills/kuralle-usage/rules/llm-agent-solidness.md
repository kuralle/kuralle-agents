# Rule: LLM Agent Solidness

## MUST

- Compose prompts as global policy + local agenda.
- Keep SOP in flows, not in freeform prompts.
- Use strict tool schemas and deterministic data outputs.
- Use idempotency for all side-effecting tools.
- Persist message-level events for replay/debug.
- Use structured triage for routing decisions.

## MUST NOT

- Let tools emit user-facing prose.
- Trigger transitions without explicit contract conditions.
- Depend on token-delta logging as primary audit trail.
- Treat model upgrade alone as a robustness plan.
