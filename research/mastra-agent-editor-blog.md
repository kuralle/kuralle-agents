# Introducing Agent Editor (Mastra) — source capture

Source: https://mastra.ai/blog/introducing-agent-editor (published 2026-04-08, by Daniel Lew)
Captured: 2026-06-07 via Firecrawl.

---

Mastra Studio now has an Agent Editor that lets subject matter experts and product teams iterate on agent behavior from Studio, without touching code or redeploying.

Developers define agents in code as usual. The editor stores changes separately with a draft/publish workflow, so you can compare versions, roll back, and keep a full history of your agent's configuration.

## Why we built this

Building an agent is only the first step. Once it's running, you need to iterate on it: adjust instructions, add tools, and monitor results. When all of that lives in code, every change goes through the cycle of edit, commit, deploy. That's slow, and it limits who on your team can participate. The people closest to the problem are often not the ones who can make changes to the codebase.

The Editor moves agent configuration into Studio. Make a change, test it, monitor results, publish. No PR review or deploy required.

Combined with datasets, you can run experiments to test changes before publishing, and debug with logs and traces.

## Get started

Upgrade to `@mastra/core` 1.24.0 or later and install the editor package:

```
npm install @mastra/editor
```

Then add the editor to your Mastra instance and configure storage:

```ts
// src/mastra/index.ts
import { Mastra } from "@mastra/core";
import { MastraCompositeStore } from "@mastra/core/storage";
import { LibSQLStore } from "@mastra/libsql";
import { MastraEditor } from "@mastra/editor";

export const mastra = new Mastra({
  // ...
  storage: new MastraCompositeStore({
    id: "mastra-storage",
    default: new LibSQLStore({...}),
    editor: new LibSQLStore({
      id: "mastra-editor",
      url: "file:./editor.db"
    })
  }),
  editor: new MastraEditor(),
});
```

The editor needs a storage provider to persist version snapshots and configuration changes outside of your codebase. Within `MastraCompositeStore`, the `editor` key is its own storage domain, so you can point it at a different database than the rest of your Mastra storage. Supports LibSQL, PostgreSQL, MongoDB.

### 1. Open the Editor in Studio
Open Studio and select an existing code-defined agent to start editing its configuration.

### 2. Configure tools
Add tools from your project, connect MCP clients to pull in tools from external servers. You can override the tool description from any source. Also supports integration providers like Composio and Arcade.

```ts
// src/mastra/index.ts
import { Mastra } from '@mastra/core'
import { MastraEditor } from '@mastra/editor'
import { ComposioToolProvider } from '@mastra/editor/providers/composio'

export const mastra = new Mastra({
  // ...
  editor: new MastraEditor({
    toolProviders: {
      composio: new ComposioToolProvider({
        apiKey: process.env.COMPOSIO_API_KEY!,
      }),
    },
  }),
})
```

### 3. Instructions and prompt blocks
Write instructions inline on the agent itself, or pull in prompt blocks. Prompt blocks are created under the Prompts section in Studio and can be shared across multiple agents. Both support Markdown and `{{variable}}` interpolation, where variables are resolved from `requestContext` when the agent runs.

### 4. Save and publish
Click **Save** to create a draft version. Click **Publish** to make it live. Once published, the new config applies to any application using the agent. You can tag each version with a change message.

## Versioning
Every save creates an immutable version snapshot. The agent record tracks which version is published, so you can have multiple drafts without affecting what's live. Compare changes between versions, browse history, restore a previous version.

All agent endpoints accept a version parameter. Pass a `versionId` or `status` when calling `.generate()`, `.stream()`, or any other agent method:

```ts
// Load the published version (default)
const agent = mastra.getAgentById("support-agent");
// Load the latest draft
const agent = mastra.getAgentById("support-agent", { status: "draft" });
// Load a specific version
const agent = mastra.getAgentById("support-agent", { versionId: "abc-123" });
```

Pin a version per environment, roll back to a known-good config, or run A/B tests by routing different requests to different versions.

## Display conditions
Both tools and prompt blocks support display conditions — rules evaluated against `requestContext` when the agent runs. Configured visually in Studio. e.g. restrict a refund tool to admin users by checking `requestContext.userRole`. The rules engine supports AND/OR groups with operators like `equals`, `contains`, `greater_than`, `in`, and `exists`.

## Access control
The Editor is protected by Studio Auth, which locks down both the API endpoints and the Studio UI. RBAC lets you control what each user can do (e.g. `member` can edit drafts, only `admin` can publish).

## What you can configure
Update instructions, tools, MCP clients, and variables on code-defined agents. Fields like the agent's `id`, `name`, and `model` come from your code and can't be changed through the editor.

## Programmatic access
The full editor API is available through `mastra.getEditor()` and the REST API at `/api/stored/agents`. Access to the complete agent configuration surface, including memory, scorers, sub-agents, workflows, and conditional variants on nearly every field. Useful for CI pipelines or building agent management into your own tooling.

```ts
import { mastra } from "./mastra";
const editor = mastra.getEditor();
// Update an agent's instructions (automatically creates a new draft version)
await editor.agent.update({
  id: "support-agent",
  instructions: "You are a customer support agent. Always greet the customer by name.",
});
```

Agents can also use the API to update their own or other agents' configuration based on what they learn at runtime.

## Key primitives extracted (editorial)
- **Code defines the agent skeleton** (`id`, `name`, `model` immutable); editor overlays mutable config (instructions, tools, MCP clients, variables).
- **Separate storage domain** for editor state — version snapshots persisted outside the codebase.
- **Draft/publish + immutable version snapshots**, version pinning per environment, rollback, A/B by version.
- **Prompt blocks** = shareable instruction fragments with `{{variable}}` interpolation from `requestContext`.
- **Display conditions** = rules engine (AND/OR, equals/contains/gt/in/exists) over `requestContext` gating tools & prompt blocks at runtime.
- **REST API** (`/api/stored/agents`) + programmatic editor (`mastra.getEditor()`) — the UI is just a client of this API; CI and agents-editing-agents use the same surface.
- **RBAC + auth** gate who edits vs publishes.
