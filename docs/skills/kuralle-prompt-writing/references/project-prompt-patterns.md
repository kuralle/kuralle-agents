# Project Prompt Patterns (Aria)

This guide reflects what works in Kuralle runtime: short, direct prompts with explicit tool contracts outperform structured prompt-builders for tool calling. For a concrete rewrite example, see `case-study-medical-office.md`.

## 1) Prompt composition pattern

Use 3 layers:

1. Global role policy:
- identity, safety boundaries, truthfulness standard
- what to do when uncertain

2. Local agenda:
- current task only
- one-turn objective

3. Transition/tool contract:
- when to call tools
- when to stay in current task
- when to route/handoff

## 2) What prompts should and should not do

Prompts should:
- define behavior and decision policy
- define response style and uncertainty handling
- define tool-use intent

Prompts should not:
- encode state machines
- store long procedural scripts
- embed fragile branching logic

If a prompt includes “first ask X then Y then Z”, that belongs in a flow.

## 3) LLM agent pattern

Good LLM prompt traits:
- explicit “do not guess”
- explicit “use tools when factual verification is needed”
- explicit “if tool fails, tell user what you can/can’t do and next step”
- explicit “summarize tool results before answering”

## 4) Flow node prompt pattern

Each node prompt should:
- ask for one atomic piece of information
- restate current objective
- avoid global recap unless needed

Keep node prompts short and concrete. Global role prompt carries reusable behavior.

## 5) Triage prompt pattern

Triage prompt must:
- select target specialist
- provide short reason
- never answer user directly

Use structured triage mode so runtime enforces output shape.

## 6) Robustness clauses to include

Add these behavior clauses explicitly:
- If data is missing or uncertain, ask a clarifying question.
- Never invent policy, pricing, or status.
- Prefer tool-grounded statements over memory guesses.
- If blocked by policy/tool error, give safe fallback and next action.

## 7) Anti-patterns

- “Be smart / be proactive” without constraints.
- Long persona content that dilutes operational instructions.
- Mixed directives (“be concise” + “explain everything in detail”).
- Tool instructions that allow freeform unsafe side effects.

## 8) Voice agent prompt patterns

Voice is different: responses are synthesized, heard once, and interrupted. Prompt for audio output, not text.

**One ask per turn.** Never stack questions:
- ❌ `”What is your name and date of birth?”` — user has to juggle two answers
- ✅ `”What is your name?”` — then ask DOB in the next turn

**Short, spoken-length utterances.** If the response would look like a paragraph, it will feel like a wall of speech. Prompt explicitly:
```
Keep responses to 1-2 sentences. Do not use lists or headers.
```

**Tool latency is silence.** If you call a tool, the user hears dead air. Acknowledge first:
```
Before calling a slow tool, say something brief like “Let me check that for you.” 
Then call the tool.
```

**No markdown.** Bullet points, bold text, and headers become spoken literally or as pauses. Instruct the model to never use them.

**Extraction context.** In voice extraction nodes, the `extractionModel` runs on transcribed text — not the audio model. Set `extractionModel` on the authority (see `docs/skills/kuralle-voice-agents/rules/extraction-model-required.md`). The voice model's prompt still needs to ask naturally.

**Use `.voiceRules()` on AgentPrompt** to inject all these constraints programmatically instead of writing them manually every time:
```ts
const prompt = new AgentPrompt()
  .role('You are a voice scheduling assistant.')
  .voiceRules({ language: 'en', maxSentences: 2 });
```

## 9) AgentPrompt vs plain strings

**Plain strings** are best for flow nodes where tool calling is the primary goal — structure dilutes instruction salience.

**AgentPrompt** is best when you need:
- Consistent security profiles across many agents (`'minimal' | 'safe' | 'regulated'`)
- Token budget control (auto-shrinks low-priority sections at context limit)
- Voice rules injection (`.voiceRules()`)
- Async knowledge injection (`.knowledge(async ctx => ...)`)

If you're writing the same safety clause in every prompt, move it to `AgentPrompt` with a security profile.
See `docs/skills/kuralle-usage/references/agent-prompt.md` for full API.
