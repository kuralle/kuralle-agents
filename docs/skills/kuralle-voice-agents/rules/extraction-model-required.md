# extractionModel Is Required for Voice Extraction

## The problem

Native audio models hallucinate extracted fields. The model may say "I've noted your date of birth as June 15th" when the user never stated it. In text mode, the collect schema rejects invented values. In voice mode, the model controls what goes into the extraction call — and it can invent values with confidence.

## The solution

Set `extractionModel` on `createRuntime`. Post-turn verification:

1. Takes the actual user transcript (not the model's self-report)
2. Calls the extraction model with `"Extract only facts explicitly stated. Return null for unknown fields."`
3. Merges non-null results into flow state

Because the extraction model only sees what the user actually said, it cannot accept a field the model invented.

```ts
import { createRuntime, defineAgent } from '@kuralle-agents/core';
import { openai } from '@ai-sdk/openai';

const runtime = createRuntime({
  agents: [receptionistAgent],
  defaultAgentId: 'receptionist',
  extractionModel: openai('gpt-4o-mini'), // cheap — runs post-turn only
  voiceMode: true,
});
```

Pass `VoiceDriver` on each turn: `runtime.run({ sessionId, input: transcript, driver })`.

## Cost

`gpt-4o-mini` runs post-turn extraction on each user transcript. For a 10-turn conversation, that is 10 cheap completion calls. This is far less expensive than a hallucinated slot corrupting a booking or record.

## Without extractionModel

Without it, the runtime uses a conservative heuristic that catches obvious hallucinations (impossible values, repeated invented strings) but misses subtle ones. Do not rely on the heuristic for production voice extraction flows.
