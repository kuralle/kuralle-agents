# Getting Started (Tools)

## Install

```bash
bun add @kuralle-agents/tools @kuralle-agents/rag @kuralle-agents/core ai @ai-sdk/openai
```

## Minimal Example

```ts
import { openai } from '@ai-sdk/openai';
import { createStaticKnowledgeSource, createLLMRetriever } from '@kuralle-agents/rag';
import { createCagTool, createCagAnswerTool } from '@kuralle-agents/tools';

const supportSource = createStaticKnowledgeSource({
  id: 'support-pack',
  name: 'Support Pack',
  content: 'Refunds: 30 days. Cancellations: anytime.',
});

const retriever = createLLMRetriever({
  model: openai('gpt-4o-mini') as any,
  topK: 4,
});

const cag = createCagTool({ sources: [supportSource], retriever });
const cagAnswer = createCagAnswerTool({
  generatorModel: openai('gpt-4o') as any,
});

const { chunks } = await cag.execute({ query: 'What is the refund policy?' });
const result = await cagAnswer.execute({ query: 'What is the refund policy?', chunks });

console.log(result.text);
```

## Example (runtime loop)

Run the bundled example:

```bash
cd packages/kuralle-tools/examples/auto-retrieve-runtime
bunx tsx run.ts
```

## Example (auto-retrieve + triage)

Structured triage + always-on retrieval.

```bash
cd packages/kuralle-tools/examples/auto-retrieve-triage
bunx tsx run.ts
```

## Example (enterprise SOP)

Flow-based support SOP with validation + ticketing.

```bash
cd packages/kuralle-tools/examples/enterprise-support-agent
bunx tsx run.ts
```
