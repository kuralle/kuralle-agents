# Debugging Tool Calling Issues

## Symptom: Model Chats Instead of Calling Tools

The model responds with text like "Sure, I can help with that" instead of calling the routing tool.

## Debugging Checklist

### 1. Check limits on agent

```ts
defineAgent({
  id: 'hospital',
  limits: { maxSteps: 25 }, // default is generous; rarely the issue
});
```

### 2. Check Tool Availability

Inspect what tools the current `reply` node exposes:

```ts
// Log from a hook
onToolCall: async (ctx, call) => console.log('Tool called:', call.toolName),
```

**Finding:** If tools are missing, check that they're registered on the active node via `buildToolSet`.

### 3. Check for Duplicate Tools

```ts
// ❌ BAD: Two tools doing the same thing
tools: buildToolSet({
  route_to_specialist: defineTool({ ... }),
  appointments: defineTool({ ... }), // same intent
})
```

**Finding:** Remove duplicate routing tools; keep one tool per intent.

### 4. Check Prompt Format

```ts
// ❌ BAD: Tool instructions buried in structured prompt sections
const prompt = new AgentPrompt()
  .role('...')
  .guardrails(['Call appointments({})']) // gets buried

// ✅ GOOD: Direct string with tool instructions prominent
instructions: `CALL THESE TOOLS:
- appointments({}) when user wants to book

User: "I need a doctor" → appointments({})`
```

### 5. Test via createRuntime

Isolated node logic can pass while full Runtime tests fail.

```ts
import { createRuntime } from '@kuralle-agents/core';

const runtime = createRuntime({
  agents: [agent],
  defaultAgentId: 'hospital',
});

const handle = runtime.run({ input: 'I need to book', sessionId: 'test-1' });
for await (const part of handle.events()) {
  if (part.type === 'tool-call') console.log('TOOL:', part.toolName);
}
```

### 6. Use Debug Event Loop

```ts
for await (const part of handle.events()) {
  console.log(`[${part.type}]`, part.toolName || part.text?.substring(0, 50));
}
```

Look for:
- `[tool-call] appointments` ← Good!
- `[flow-transition]` ← Transition happened!
- `[text-delta]` only ← Model is chatting, not calling tools

## Common Issues & Fixes

| Issue | Cause | Fix |
|-------|-------|-----|
| No tool calls | Buried tool instructions | Use direct string on `reply.instructions` |
| Wrong tool called | Duplicate tools | One tool per intent |
| Tool called but no transition | `next` doesn't check tool name | Inspect `turn.toolResults` in `next` |
| Sometimes works, sometimes doesn't | Inconsistent prompt | Simplify and be explicit |
