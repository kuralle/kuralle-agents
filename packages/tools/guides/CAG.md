# CAG Tools

Two tools, split responsibilities:

- **CAGTool** → retrieval only, returns chunks.
- **CAGAnswerTool** → answer only, returns `{ type: 'final', text }`.

## CAGTool (retrieve)

Input

```ts
{ query: string; topK?: number; hint?: string }
```

Output

```ts
{ chunks: ChunkDef[] }
```

## CAGAnswerTool (answer)

Input

```ts
{ query: string; chunks: ChunkDef[] }
```

Output

```ts
{ type: 'final'; text: string; reasons?: string[]; chunks: ChunkDef[] }
```

## Grounding Rules

- Retriever selects from approved `KnowledgeSource` chunks only.
- Answer tool uses only provided chunks.

## Notes

- Tool loop is handled by the Runtime.
- Auto-retrieve (always-on) is a runtime feature; it calls the retriever tool and injects context before the model runs.
