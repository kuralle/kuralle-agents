# Rule: Prompt Quality Gates

## MUST

- Keep prompts role-and-policy focused; keep SOP in flows.
- Include uncertainty handling ("ask/verify when unsure").
- Define explicit tool-use policy.
- Define failure behavior for tool unavailability/errors.
- Use structured triage prompts for routing agents.

## MUST NOT

- Put multi-step workflow scripts in a single LLM prompt.
- Allow triage prompts to answer end users.
- Use vague instructions as primary control ("be intelligent", "use judgment") without constraints.
- Rely on model upgrade alone to fix prompt ambiguity.
