# Input & Output Guardrails

Block, modify, or allow messages before they reach the LLM (input) or after the LLM responds (output).

## InputProcessor

```ts
import { type InputProcessor, createRuntime, defineAgent } from '@kuralle-agents/core';

const guardrail: InputProcessor = {
  id: 'safety-guardrail',
  name: 'Safety Guardrail',
  process: ({ input, context }) => {
    if (/ignore.*instructions|jailbreak|system prompt/i.test(input)) {
      return {
        action: 'block',
        message: 'I can only help with questions related to our services.',
        reason: 'prompt_injection',
      };
    }
    return { action: 'allow' };
  },
};
```

### process() return values

| Action | Fields | Effect |
|--------|--------|--------|
| `allow` | — | Message passes through to LLM |
| `block` | `message`, `reason?` | LLM is skipped; `message` is sent to user; stream emits `tripwire` event |
| `modify` | `text`, `reason?` | Replaced `text` is sent to LLM instead of original |

### Attach to agent via guardrails

```ts
const agent = defineAgent({
  id: 'support',
  instructions: 'Be helpful.',
  guardrails: {
    input: [guardrail],
  },
});

const runtime = createRuntime({ agents: [agent], defaultAgentId: 'support' });
```

Global processors can also attach at runtime config when loading from packs.

### Handle the tripwire event in the stream

```ts
const handle = runtime.run({ input, sessionId });
for await (const part of handle.events()) {
  if (part.type === 'tripwire') {
    console.log(`[BLOCKED] ${part.reason} — message sent: "${part.message}"`);
  }
  if (part.type === 'text-delta') {
    process.stdout.write(part.delta);
  }
}
```

## OutputProcessor

Same pattern, applied after the LLM responds:

```ts
import { type OutputProcessor } from '@kuralle-agents/core';

const piiRedactor: OutputProcessor = {
  id: 'pii-redactor',
  name: 'PII Redactor',
  process: ({ text }) => {
    const redacted = text
      .replace(/\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g, '[PHONE REDACTED]')
      .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, '[EMAIL REDACTED]');

    if (redacted !== text) {
      return { action: 'modify', text: redacted, reason: 'PII detected' };
    }
    return { action: 'allow' };
  },
};

defineAgent({
  id: 'support',
  guardrails: { output: [piiRedactor] },
});
```

## Per-session violation tracking

For escalation flows that terminate after repeated violations:

```ts
const violationCounts = new Map<string, number>();

const guardrail: InputProcessor = {
  id: 'violation-tracker',
  process: ({ input, context }) => {
    const sessionId = context.session?.id ?? 'unknown';
    const count = (violationCounts.get(sessionId) ?? 0) + 1;
    violationCounts.set(sessionId, count);
    if (count >= 3) {
      return { action: 'block', message: 'Conversation ended due to policy violations.', reason: `violation_${count}` };
    }
    return { action: 'block', message: 'Please rephrase.', reason: 'policy' };
  },
};
```
