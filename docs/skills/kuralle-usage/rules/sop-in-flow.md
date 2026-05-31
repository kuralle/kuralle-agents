# Rule: SOP Lives In Flow

## MUST

- Put SOP steps in flow nodes.
- Ask one question per node.

## MUST NOT

- Put SOP steps in system prompts.
- Skip validation steps.

## Example

Bad (prompt SOP):

"Ask for id, then ask for pin, then create ticket"

Good (flow SOP):

- node: collect_id
- node: collect_pin
- node: create_ticket
