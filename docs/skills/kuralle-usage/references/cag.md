# CAG (Always-Grounded Retrieval)

## Contents

- CAG vs RAG
- CAGTool / CAGAnswerTool
- Auto-retrieve config
- Prompt caching notes

## CAG vs RAG

CAG keeps grounding inside a preloaded context and uses retrieval over approved sources. Use it when you want strict grounding without external vector infra.

## Tool split

- `CAGTool`: retrieval only
- `CAGAnswerTool`: answer only

```ts
const { chunks } = await cagTool.execute({ query });
const result = await cagAnswerTool.execute({ query, chunks });
```

## Auto-retrieve config

```jsonc
{
  "runtime": {
    "autoRetrieve": { "type": "tool", "toolName": "cag_retrieve" }
  }
}
```

## Prompt caching

If your provider supports caching, keep static knowledge in the retriever prompt prefix so repeated tool calls reuse cached tokens.
