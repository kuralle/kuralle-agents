# Rule: Tool Output Contract

## MUST

- Return data only.
- Keep output deterministic.
- Use schemas for input validation.

## MUST NOT

- Return user-facing prose.
- Return HTML/markdown unless requested.

## Example

Bad:

"Order shipped yesterday. Anything else?"

Good:

```json
{ "orderId": "123", "status": "shipped", "etaDays": 2 }
```
