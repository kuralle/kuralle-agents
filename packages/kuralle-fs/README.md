# @kuralle-agents/fs

Portable filesystem primitive for Kuralle agents — zero `node:*` imports, runs on Node and Cloudflare Workers.

Design re-authored from the [Cloudflare Agents SDK](https://github.com/cloudflare/agents) `shell` filesystem layer (interface shape and Workers portability). See `research/cloudflare-agents-sdk/packages/shell/src/fs/` in this repo for the reference design.

## Install

```bash
npm install @kuralle-agents/fs @kuralle-agents/core
```

## Quick start

```ts
import { defineAgent, createRuntime } from '@kuralle-agents/core';
import { InMemoryFs } from '@kuralle-agents/fs';

const workspace = new InMemoryFs({
  '/kb/faq.md': '# FAQ\n\nHow do I reset my password?',
});

const agent = defineAgent({
  id: 'support',
  model,
  instructions: 'Answer from the knowledge base using the workspace tool.',
  workspace, // auto-registers durable `workspace` tool
});

const runtime = createRuntime({ agents: [agent], defaultAgentId: 'support' });
```

## Workspace tool

`createFsTool({ fs, readOnly?, timeoutMs? })` exposes one durable effect tool named `workspace` with ops:

| Op | Purpose |
|----|---------|
| `ls` | List directory entries |
| `cat` / `read` | Read file contents |
| `grep` | Regex search across files |
| `find` | Glob match under a root |
| `write` | Write file (throws `EROFS` when `readOnly`) |
| `edit` | Find/replace within a file |

Tools return structured data (`{ op, ok, ... }`), not conversational text.

## Out-of-band access

When `AgentConfig.workspace` is set, the same `FileSystem` instance is available on `RunContext.fs` and `ActionContext.fs` for flow `action` nodes — useful for staging files the model should not see in the transcript.

## API

- `FileSystem` — async POSIX-ish interface (types live in `@kuralle-agents/core`, re-exported here)
- `InMemoryFs` — in-memory tree, seed with `new InMemoryFs({ '/path': 'content' })`
- `createFsTool` — durable workspace tool factory
- `path-utils`, `encoding` — portable helpers (no Node built-ins)

## Example

```bash
bun packages/kuralle-fs/examples/kb-agent.ts
```

## License

Apache-2.0
