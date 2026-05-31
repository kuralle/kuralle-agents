# Voice Prompt Rules

Voice agents use the same `defineAgent`, `createRuntime`, tools, and flows as text agents. These rules apply only in voice contexts.

## One ask per turn

Voice is linear and ephemeral. Unlike a chat log the user can scroll, speech is heard once and retained in working memory. A node that stacks multiple questions produces an overloaded prompt — callers either answer the last question only or get confused.

**Wrong:**
```
"Please provide your name, date of birth, insurance policy number, and the reason for your call."
```

**Right:**
```
"What is your name?"
```

Move to the next question in the next node. Use `collect` nodes to gather multiple fields naturally across turns.

## Short, spoken-style utterances

Written copy often uses lists, bold headings, and multi-clause sentences. Voice LLMs inherit these habits and produce unnatural speech.

**Wrong:**
```
"Here are your options: 1) Track your order, 2) Cancel an order, 3) Speak to support."
```

**Right:**
```
"Would you like to track an order, cancel one, or reach our support team?"
```

The same information, reframed as a single question the caller can answer naturally.

## Tool latency = dead air

Tool calls and retrieval that are invisible in text become silence in voice. The caller hears nothing and may think the call dropped. Options:
- Keep tool execution under 500ms when possible
- Use voice interim fillers on `defineTool` for slow lookups
- Providers like Gemini Live can emit filler audio while waiting for tool results

## extractionModel is required in voice

Voice models can confidently assert extracted slots the user never supplied. They say "I've noted your name as Sarah" when the user never gave a name. The extraction verification layer catches this by re-extracting from the actual user transcript.

If you define a `collect` node without `extractionModel` on `createRuntime`, the runtime falls back to a conservative heuristic guard that catches obvious cases but is not reliable for production.

```ts
const runtime = createRuntime({
  agents: [agent],
  defaultAgentId: agent.id,
  extractionModel: openai('gpt-4o-mini'),
  voiceMode: true,
});
```

## VoiceRules on AgentPrompt

When using `AgentPrompt`, add `.voiceRules()` to generate TTS formatting instructions:

```ts
const prompt = new AgentPrompt()
  .role('You are a phone booking assistant.')
  .voiceRules({
    useSpellTags: true,
    useBreakTags: true,
    formatDates: 'speakable',
    formatTimes: '12h',
    verbalizeCurrency: true,
  });
```

## Multilingual (Gemini Live)

Gemini Live infers the caller's language from audio automatically. No locale configuration needed. The prompt can enforce an immediate language-mirror policy if needed:

```ts
instructions: 'Always respond in the same language the caller uses. Switch immediately on the first message.'
```
