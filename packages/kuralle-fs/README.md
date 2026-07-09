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

## Composite mounts

`CompositeFileSystem` federates multiple backends behind one `FileSystem` — longest path-prefix wins, `readdir('/')` lists mount roots, and `cp`/`mv` work across mounts:

```ts
import { CompositeFileSystem, InMemoryFs } from '@kuralle-agents/fs';

const workspace = new CompositeFileSystem({
  mounts: {
    '/docs': new InMemoryFs({ '/handbook.md': '# Handbook' }),
    '/scratch': new InMemoryFs(),
  },
});

const workspaceTool = createFsTool({ fs: workspace, readOnly: false });

const agent = defineAgent({
  id: 'support',
  model,
  instructions: 'Read bundled docs from /docs; draft notes under /scratch.',
  workspace: { fs: workspace, readOnly: false },
  globalTools: { workspace: workspaceTool },
});
```

Writable workspaces are not auto-exposed in `globalTools` (ADR 0006); register the tool explicitly when `readOnly: false`.

Mark a mount read-only with a `readOnly: true` property on the backend instance (e.g. `KnowledgeFs`). `CompositeFileSystem.readOnly` is `true` only when every mount is read-only.

The `workspace` tool caps its output (read ≤2000 lines / 50KB with `offset`/`limit`, grep ≤200 hits, lines ≤500 chars) and marks truncation with `truncated: true`. `edit` throws on an ambiguous match — pass `replaceAll: true` for multi-match replaces.

## Skills (SKILL.md folders on the filesystem)

Skills live on any `FileSystem` as `SKILL.md` folders following the [agentskills.io](https://agentskills.io) spec. `fsSkillStore` discovers them and implements the core `SkillStoreLike`, so it drops straight into `AgentConfig.skills` — progressive disclosure (metadata in the prompt, body + `references/` loaded on demand) is handled by the runtime.

```ts
import { InMemoryFs, fsSkillStore, defineSkill } from '@kuralle-agents/fs';

const fs = new InMemoryFs({
  '/skills/refunds/SKILL.md': '---\nname: refunds\ndescription: Handle refunds.\n---\n\n# Refunds\n...',
  '/skills/refunds/references/policy.md': '# Policy\n30-day window.',
});

const agent = defineAgent({
  id: 'support',
  model,
  instructions: 'Load a skill when it fits the task.',
  workspace: fs,
  skills: fsSkillStore(fs), // gives the agent load_skill + read_skill_resource
});
```

`defineSkill({ name, description, instructions, resources })` builds an inline skill without a filesystem.

## Open Knowledge Format (OKF)

An [OKF v0.1](https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf) bundle is *just markdown + YAML frontmatter + files* — knowledge concepts (tables, metrics, runbooks) that cross-link into a graph. Because it's a directory of files, a kuralle `workspace` **is** an OKF consumption agent with no adapter: the agent navigates `index.md` → concept → bundle-relative links via `ls`/`read`/`grep`.

```ts
import { okfBundleToFs, listOkfConcepts, createFsTool, defineAgent } from '@kuralle-agents/fs'; // createFsTool/defineAgent from core

const fs = okfBundleToFs({
  '/index.md': '# Sales\n* [Orders](/tables/orders.md)',
  '/tables/orders.md': '---\ntype: BigQuery Table\ntitle: Orders\n---\n# Schema\n...',
});
const concepts = await listOkfConcepts(fs); // [{ id, type, title, links, ... }]
const agent = defineAgent({ id: 'analyst', model, workspace: fs, tools: { workspace: createFsTool({ fs }) } });
```

`parseOkfConcept`, `listOkfConcepts`, and `okfBundleToFs` implement the permissive OKF consumption model (spec §9): only `type` is required, unknown fields/broken links are tolerated. See `examples/okf-knowledge-agent.ts` (live navigation) and `examples/okf-benchmark.ts` (progressive-disclosure vs whole-dump).

## Shell (`@kuralle-agents/fs/shell`, `/node`, `/cloudflare`)

A workspace can carry a `Shell` alongside its `FileSystem`; the runtime then exposes a durable `bash` tool. Three backends mirror flue's model:

```ts
import { virtualShell } from '@kuralle-agents/fs/shell'; // just-bash over an in-memory fs — Node / CF container
import { nodeShell } from '@kuralle-agents/fs/node';     // real host shell (env-allowlisted, tree-kill)
import { cloudflareShell } from '@kuralle-agents/fs/cloudflare'; // wraps a @cloudflare/sandbox DO stub

const { fs, shell } = virtualShell({ initialFiles: { '/data.txt': 'hi' } });
const agent = defineAgent({ id: 'coder', model, workspace: { fs, shell, readOnly: false } });
```

The `bash` tool is registered into the **executor** surface only — a shell is never auto-exposed to the model; opt in per node or via `agent.tools`. Portability note: `virtualShell` pulls `just-bash` and is **not** on the root export (its `turndown` transitive is not workerd-clean); the root `@kuralle-agents/fs` stays Workers-clean, and the Cloudflare-edge shell is `cloudflareShell` (a Sandbox Durable Object), not `virtualShell`.

fs and shell tools are **non-replayed** (`replay: false`): they always execute fresh rather than return a stale durable-journal result — at-least-once, always-fresh (see ADR-0012).

## API

- `FileSystem` — async POSIX-ish interface (types live in `@kuralle-agents/core`, re-exported here)
- `InMemoryFs` — in-memory tree, seed with `new InMemoryFs({ '/path': 'content' })`
- `CompositeFileSystem` — path-routed mount table over multiple `FileSystem` backends
- `createFsTool` — durable, capped, read-only-by-default workspace tool factory
- `fsSkillStore`, `defineSkill`, `parseSkillFrontmatter` — SKILL.md skills on a filesystem
- `okfBundleToFs`, `listOkfConcepts`, `parseOkfConcept` — Open Knowledge Format (OKF v0.1) bundles
- `virtualShell` / `bashShell` (`/shell`), `nodeShell` (`/node`), `cloudflareShell` (`/cloudflare`) — `Shell` backends
- `path-utils`, `encoding` — portable helpers (no Node built-ins)

## Examples

```bash
bun packages/kuralle-fs/examples/kb-agent.ts
bun packages/kuralle-fs/examples/skills-on-fs.ts   # deterministic, no key
KURALLE_EXAMPLE_PROVIDER=openai bun packages/kuralle-fs/examples/composite-workspace.ts
KURALLE_EXAMPLE_PROVIDER=openai bun packages/kuralle-fs/examples/workspace-skills-shell.ts  # live: model uses bash + a fs skill
KURALLE_EXAMPLE_PROVIDER=openai bun packages/kuralle-fs/examples/okf-knowledge-agent.ts     # live: agent navigates an OKF bundle
KURALLE_EXAMPLE_PROVIDER=openai bun packages/kuralle-fs/examples/okf-benchmark.ts           # benchmark: progressive vs whole-dump
KURALLE_EXAMPLE_PROVIDER=openai bun packages/kuralle-fs/examples/skill-latency-spike.ts     # benchmark: with vs without skills
```

## License

Apache-2.0
