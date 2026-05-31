# Rule: No Redundant Tools

## The Rule

Do NOT create explicit routing tools that duplicate implicit tools from transitions.

## Why

1. **Model confusion**: Two tools with same purpose = unpredictable behavior
2. **Tool collision**: Explicit tools override implicit on name collision
3. **Maintenance burden**: Two places to update routing logic

## Examples

### ❌ Wrong

```javascript
// Explicit routing tool
const route_to_specialist = createTool({
  inputSchema: z.object({
    target: z.enum(['appointments', 'services'])
  }),
  execute: ({ target }) => createFlowTransition(target)
});

// Node uses explicit tool
{
  id: 'triage',
  tools: { route_to_specialist }
}

// Transitions ALSO create implicit tools
transitions: [
  { from: 'triage', to: 'appointments', on: 'appointments' },
  { from: 'triage', to: 'services', on: 'services' },
]
```

Result: Model sees `route_to_specialist`, `appointments`, and `services` - redundant!

### ✅ Right

```javascript
// No explicit routing tools
{
  id: 'triage',
  tools: {
    check_emergency: ...,
    transfer_to_human: ...,
  }
}

// Implicit tools handle all routing
transitions: [
  { from: 'triage', to: 'appointments', on: 'appointments' },
  { from: 'triage', to: 'services', on: 'services' },
]
```

Result: Model sees only `appointments` and `services` - clear intent.

## When Explicit Tools Are OK

- Tools that do more than routing (e.g., `check_emergency` which classifies)
- Tools that transform data before routing
- Tools that need complex input schemas

But for simple routing: use implicit tools.
