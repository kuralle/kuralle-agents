# Tools Package (80/20)

## What it is

`@kuralle-agents/tools` ships CAG tools.

## CAG tools

- `CAGTool` → returns chunks
- `CAGAnswerTool` → returns final answer (grounded)

```ts
const { chunks } = await cagTool.execute({ query });
const result = await cagAnswerTool.execute({ query, chunks });
```

## Auto-retrieve (runtime)

Use runtime config to call CAGTool before every model run:

```jsonc
{
  "runtime": {
    "autoRetrieve": { "type": "tool", "toolName": "cag_retrieve" }
  }
}
```

## Where to read more

- `node_modules/@kuralle-agents/tools/guides/`
  - `CAG.md`
  - `GETTING_STARTED.md`
