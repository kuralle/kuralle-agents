# AgentPrompt (Structured Prompts)

`AgentPrompt` builds type-safe, inspectable prompts with security bookends, token budgeting, XML-tagged sections, and dynamic content injection. Use it when you need more than a plain string prompt.

## When to use AgentPrompt

- Regulated environments that need security policy sections
- Agents with dynamic knowledge (database content, catalog)
- Voice agents that need TTS formatting rules
- Any prompt you want to inspect, test token counts on, or render programmatically

Plain strings are fine for simple agents.

## Basic usage

```ts
import { AgentPrompt } from '@kuralle-agents/core/prompts';

const prompt = new AgentPrompt()
  .role('You are a customer support agent.')
  .instructions('Help users with billing and account issues.')
  .guardrails('Never share account passwords. Verify identity first.');

const agent = { id: 'support', type: 'llm', model: openai('gpt-4o-mini'), prompt };
```

## Security policy profiles

```ts
const prompt = new AgentPrompt({ policy: 'regulated' });
```

| Profile | Adds |
|---------|------|
| `minimal` | Stay on topic, don't invent facts. Default. |
| `safe` | Tool failure honesty, action verification, team/agent context. |
| `regulated` | Confirm before regulated actions, audit logging, escalate when confidence is low. |

Auto-injected security sections (non-shrinkable) wrap your content in XML:
```xml
<security_core>...</security_core>
<role>...</role>
<instructions>...</instructions>
<security_reminder>...</security_reminder>
```

Use `{ xmlTags: false }` to disable XML wrapping (not recommended for Claude models).

## Dynamic knowledge

```ts
const prompt = new AgentPrompt()
  .role('You are a shopping assistant.')
  .knowledge(async () => {
    const catalog = await db.getActiveCatalog();
    return catalog.map(p => `- ${p.name}: $${p.price}`).join('\n');
  });
```

Any section method accepts async functions. The content resolves at `.render()` time.

## Token budgeting

```ts
const prompt = new AgentPrompt({ maxTokens: 4000 })
  .role('You are a support agent.')
  .instructions('Handle billing questions.')
  .knowledge(longKnowledgeBase)   // ← shrinkable
  .examples(fewShotExamples);     // ← shrinkable
```

When the rendered prompt exceeds `maxTokens`, shrinkable sections are trimmed in reverse priority order. **Shrinkable:** knowledge, tools, glossary, examples, voice. **Non-shrinkable:** role, instructions, guardrails, security sections.

## Inspect and test

```ts
const info = await prompt.debug();
console.log(info.sections);
// [{ type: 'role', tokens: 12, shrinkable: false }, { type: 'knowledge', tokens: 312, shrinkable: true }, ...]
console.log(info.totalTokens); // 385

const rendered = await prompt.render();
// Full prompt string with XML sections
```

Use `.debug()` in tests to assert section counts and token budgets.

## Voice rules

```ts
const prompt = new AgentPrompt()
  .role('You are a phone booking assistant.')
  .voiceRules({
    useSpellTags: true,        // spell out identifiers (e.g., "R-M-A")
    useBreakTags: true,        // TTS pause tags at punctuation
    formatDates: 'speakable',  // "March fifteenth" not "3/15"
    formatTimes: '12h',        // "two thirty PM" not "14:30"
    verbalizeCurrency: true,   // "forty-two dollars" not "$42"
    urlFormat: 'dot',          // "example dot com" not "example.com"
  });
```

Generates TTS-specific instructions in the prompt. Options map to your TTS provider's capabilities.

## Glossary

```ts
const prompt = new AgentPrompt()
  .glossary([
    { name: 'SKU', description: 'Stock keeping unit identifier', synonyms: ['product code', 'item number'] },
    { name: 'RMA', description: 'Return merchandise authorization number' },
  ]);
```

Formats domain terms into a structured glossary section the LLM can reference.
