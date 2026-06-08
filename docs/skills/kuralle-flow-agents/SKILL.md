---
name: kuralle-flow-agents
description: Build production-ready flow agents with proper transitions and reliable tool calling. Use when creating multi-step conversation flows with state management.
---

# Kuralle Flow Agents

Use this skill when building structured conversation flows: appointment booking, form filling, multi-step intake, or any scenario where the conversation moves through defined stages.

## Read this first

- **One agent primitive**: `defineAgent` + `flows[]` — no separate flow agent type
- **`collect` nodes collect multi-field data with zero manual submit wiring**: use them instead of rolling your own collection tools
- **Don't duplicate transition tools**: One tool per transition; let `next` handlers route on tool results
- **Prompts matter more than architecture**: Short, direct prompts = better tool calling
- **`routing.model` is the control model for routing** (the host guard / pure-dispatcher classifier): set a cheap/fast model on `routing` to cut routing latency
- **Test via full Runtime + TurnHandle**: Production behavior differs from isolated node tests

## Navigation

- `references/implicit-tools.md` - Transition tools via `next` handlers
- `references/extraction-nodes.md` - **`collect` nodes** (structured fields across turns)
- `references/advanced-flow.md` - **routing.model, contextStrategy, hybrid mode, metrics**
- `references/prompt-best-practices.md` - Prompt patterns that work vs don't
- `references/tool-calling-debug.md` - Debugging when models won't call tools
- `references/production-checklist.md` - Pre-deployment verification

Rules:

- `rules/no-redundant-tools.md`
- `rules/emergency-detection.md`

## Workflow

1. **Define your flow structure first**: nodes (`reply`/`collect`/`action`/`decide`), transitions, data collection points
2. **Wire transitions in `next` handlers**: Return `{ goto, data }` on tool results — don't add duplicate routing tools
3. **Write short, direct prompts**: Avoid burying tool instructions in long structured prompts
4. **Test with vague user input**: Ensure the flow handles ambiguity
5. **Verify transitions via debug client**: See tool calls and node changes in `TurnHandle` events
6. **Test edge cases**: Unavailable services, emergencies, OPD walk-ins

## Non-negotiables

- Do NOT add explicit routing tools that duplicate what `next` already handles
- Do NOT bury tool instructions in multi-section prompt builders when tool calling is critical
- Always test via `createRuntime` + `runtime.run()`, not isolated node mocks

## Quick Reference

```ts
const triage = reply({
  id: 'triage',
  instructions: 'CALL appointments({}) when user wants to book.',
  tools: buildToolSet({ appointments: defineTool({ ... }) }),
  next: (turn) =>
    turn.toolResults.some((r) => r.name === 'appointments')
      ? { goto: appointmentsNode, data: {} }
      : 'stay',
});

const agent = defineAgent({
  id: 'hospital',
  flows: [defineFlow({ name: 'intake', start: triage, nodes: [triage, appointmentsNode] })],
});
```

Node `next` handlers return the next node — transitions live in code, not a separate edge table.
