# Prompt Best Practices for flow agents

## Critical Rule: Structured Prompts Reduce Tool Calling

**Tested and verified:** Heavily structured prompts (sections, headers, nested guardrails) reduce tool instruction salience — models chat instead of calling tools.

### The Problem

```ts
// ❌ Too much structure buries the tool instructions
const prompt = new AgentPrompt()
  .role('You are a triage agent for a medical office.')
  .instructions(['Greet the caller warmly.', 'Listen to their concern.'])
  .guardrails(['Call appointments({}) when user wants to book'])  // Gets buried
  .build();
```

When sections compete for attention, tool calls lose. The model chats instead of routing.

### The Solution — Direct String for Tool-Heavy Nodes

```ts
// ✅ Direct string puts the tool contract front and center
const prompt = `You are a triage agent.

CALL THESE TOOLS:
- appointments({}) - when user wants to book
- services({}) - when user asks about prices

User: "I need a doctor" → appointments({})
User: "Book appointment" → appointments({})

Call the tool IMMEDIATELY. Do not chat.`;

const node = {
  prompt,  // Direct string — no builder
  tools: { appointments: ..., services: ... }
};
```

Result: Model calls tools reliably.

## Why This Happens

1. **Structure dilutes salience**: `# Role`, `# Instructions`, `# Guardrails` sections spread attention evenly
2. **Tool instructions get buried**: A tool rule on line 15 has less weight than one on line 3
3. **Token distribution**: More structure = less signal on any single instruction

## Prompt Style Decision Table

| Scenario | Use |
|----------|-----|
| Triage nodes (must route) | Direct string with tool contract at top |
| Flow node where user MUST call a transition tool | Direct string |
| Debugging why a model won't call a tool | Simplify to direct string first |
| Informational/LLM agent (tool calling optional) | AgentPrompt is fine |
| Many agents needing consistent security clauses | AgentPrompt with security profile |
| Voice agents | AgentPrompt + `.voiceRules()` |

## Emergency Detection Pattern

Be explicit about what IS and ISN'T an emergency:

```javascript
const prompt = `EMERGENCY TOOL - ONLY call for these:
- Not breathing
- Severe bleeding
- Unconscious

DO NOT call emergency for:
- General sickness ("my child is sick")
- Fever, cold (unless severe)
- "I need help" (vague - ask for clarification)
`;
```

This prevents false positives on vague inputs.
