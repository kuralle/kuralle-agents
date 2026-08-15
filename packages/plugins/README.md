# @kuralle-agents/plugins

Load [Agent Plugins v1.0.0](https://agent-plugins.org) directories into a Kuralle agent — `plugin.json`, `skills/`, `mcp.json`, and (as a host extension) `flows/`.

## Install

```bash
npm install @kuralle-agents/plugins
```

This installs `@kuralle-agents/core` and `@kuralle-agents/fs` with it. Every `@kuralle-agents/*` package versions in lockstep, so install them at the same version.

This package does **not** depend on `@kuralle-agents/mcp`. It parses `mcp.json` into validated config *data*. Connecting that data to a live client is your explicit step, so a skills-only consumer never pulls an MCP client.

## What it does

A plugin is a directory with a fixed layout. A plugin authored for another agent client loads here unmodified.

**Key exports:**

- **`loadAgentPlugin(fs, root, options?)`** — reads a plugin directory and returns a discriminated result. It never throws. Pass `hostTools` to scope action-node tool references.
- **`expandPluginPlaceholders`** — expands `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` per spec §9.2.
- **Types** — `LoadPluginResult`, `LoadedPlugin`, `LoadAgentPluginOptions`, `PluginManifest`, `McpServerConfig`, `Diagnostic`, `Rejection`.

## Layout

```
my-plugin/
  plugin.json                     manifest (required)
  skills/
    invoice-policy/
      SKILL.md                    name must match the directory
      references/rates.md         bundled resource
  flows/
    refund.flow.json              optional — Kuralle host extension
  mcp.json                        optional MCP servers
```

Agent Plugins 1.0.0 does not define `flows/`; other hosts ignore the directory. Kuralle returns validated `FlowDefinition`s on `plugin.flows` for the host to register via `runtime.addDynamicFlows`.

## Usage

```ts
import { defineAgent } from '@kuralle-agents/core';
import { NodeFileSystem } from '@kuralle-agents/fs/node/fs';
import { loadAgentPlugin } from '@kuralle-agents/plugins';

const fs = new NodeFileSystem('/srv/agents');
const loaded = await loadAgentPlugin(fs, '/.agents/plugins/acme');

if (!loaded.ok) {
  throw new Error(loaded.rejection.message);
}

for (const d of loaded.plugin.diagnostics) {
  console.warn(`${d.section} ${d.origin}: ${d.message}`);
}

const agent = defineAgent({
  id: 'billing',
  model,
  instructions: 'Answer billing questions.',
  skills: loaded.plugin.skills,
});
```

`loaded.plugin.mcpServers` holds parsed server configs. Pass them to [`@kuralle-agents/mcp`](https://www.npmjs.com/package/@kuralle-agents/mcp) to connect them. `loaded.plugin.flows` holds validated flow definitions; the host registers them with `runtime.addDynamicFlows`.

## Failure is graded, not binary

A `throw` cannot express how much of a plugin survived. A discriminated return can. The loader applies five different blast radii:

| What failed | Outcome | Skills | MCP servers | Flows |
| --- | --- | --- | --- | --- |
| `plugin.json` | Reject the whole plugin (`ok: false`) | not loaded | not loaded | not loaded |
| `mcp.json` | Disable MCP for this plugin only | loaded | `[]` + diagnostic | unchanged |
| One skill folder | Skip that skill | the rest load | unchanged | unchanged |
| One server entry | Skip that server | unchanged | siblings load | unchanged |
| One flow file | Skip that flow | unchanged | unchanged | siblings load |

A **missing** `skills/`, `mcp.json`, or `flows/` is not an error. Spec §6.2 makes an absent `skills/` or `mcp.json` legal; `flows/` is a host extension with the same missing-component rule.

## `LoadPluginResult`

```ts
type LoadPluginResult =
  | { ok: true;  plugin: LoadedPlugin }
  | { ok: false; rejection: Rejection; diagnostics: readonly Diagnostic[] };

interface LoadedPlugin {
  manifest: PluginManifest;
  skills: SkillStoreLike;                  // ready for AgentConfig.skills
  mcpServers: readonly McpServerConfig[];  // parsed, NOT connected
  flows: readonly FlowDefinition[];        // validated, NOT registered
  diagnostics: readonly Diagnostic[];
}
```

Every `Diagnostic` carries `{ section, rule, origin, message }`. The `section` names the spec clause, so you can log a failure without guessing which layer produced it.

## Credentials in plugin files

The spec forbids **plugin authors** from putting secrets in `env` or `headers`. It does not instruct a client to reject such a config, and it gives no portable place to reference a credential instead.

So a conformant client loads a secret-bearing config, reports a diagnostic, and continues. This package does that. Rejecting would refuse a config the spec does not authorise us to refuse, and the most common real-world MCP config is a bare `npx <server>` with an API key in `env`.

Supply real credentials in code, through the `auth` resolver on `@kuralle-agents/mcp`.

## `PLUGIN_ROOT` and `PLUGIN_DATA`

`${PLUGIN_ROOT}` and `${PLUGIN_DATA}` expand inside a stdio entry's `args`, `env`, and `cwd`, and reach the subprocess as environment variables. Expansion is single-pass: text introduced by one substitution is never rescanned.

`PLUGIN_DATA` is a **sibling** of the plugin directory, keyed by plugin name — a plugin at `/plugins/acme` gets `/plugins/data/acme`. Keeping it outside the plugin root means writing state never mutates the distributed bundle, so a plugin stays byte-identical to what was published. `@kuralle-agents/mcp/node` creates it and proves it writable before the subprocess starts.

A `command` is either a bare token resolved through the platform search path, or a plugin-relative `./…` path resolved against the plugin root. `cwd` defaults to the plugin root when omitted, and `cwdRoot` records which root it was declared against.

## Containment

§4.1 keeps a plugin's declared paths inside the plugin, and defines that against the **filesystem-resolved** path. A plugin can ship `bin/server` as a symlink to `/usr/bin/curl` — the string `./bin/server` looks contained.

Two checks run. Parsing catches `../` escapes early. `@kuralle-agents/mcp/node` re-checks `command` and `cwd` through `realpath` immediately before spawning, which is the first moment `${PLUGIN_DATA}` exists — resolving it at parse time would reject the specification's own `cwd` example.

Either failure invalidates that one server entry (`section: "4.1"`, `rule: "path-escapes-plugin-root"`) and leaves the plugin's skills and other servers loading. A symlink that stays inside the plugin root is permitted; this is containment, not a ban on symlinks.

It is not a sandbox — §4.1 says so. It constrains what a plugin may *declare*, not what the process it launches may do. Use `Policy` for that.

## Platform limits

`stdio` servers parse here on every runtime. They only **run** on Node and Bun, through `@kuralle-agents/mcp/node`. Cloudflare Workers have no subprocess, so a `stdio` server there fails with a named error rather than a module-resolution crash.

## Related

- [`@kuralle-agents/mcp`](https://www.npmjs.com/package/@kuralle-agents/mcp) — connect the parsed `mcpServers` to live tools.
- [`@kuralle-agents/core`](https://www.npmjs.com/package/@kuralle-agents/core) — `defineAgent`, skills, and `Policy`.
- [`@kuralle-agents/fs`](https://www.npmjs.com/package/@kuralle-agents/fs) — the `FileSystem` a plugin is read through.
