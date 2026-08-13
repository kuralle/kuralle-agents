import type { FlowDefinition, SkillStoreLike } from '@kuralle-agents/core';

export interface Diagnostic {
  section: string;
  rule: string;
  origin: string;
  message: string;
}

export interface Rejection {
  section: string;
  rule: string;
  message: string;
}

export interface PluginAuthor {
  name?: string;
  email?: string;
  url?: string;
}

export interface PluginManifest {
  $schema: string;
  name: string;
  version?: string;
  description?: string;
  author?: PluginAuthor;
  homepage?: string;
  repository?: string;
  license?: string;
  keywords?: string[];
  extensions?: Record<string, Record<string, unknown>>;
}

export type McpServerConfig =
  | {
      name: string;
      type: 'stdio';
      /** Resolved against the plugin root when the source was `./…`; a bare token otherwise. */
      command: string;
      args?: string[];
      /** Expanded plugin entries only. The launcher composes the final environment. */
      env?: Record<string, string>;
      /** Resolved. Defaults to `pluginRoot` when the plugin omitted it (§7.2.1). */
      cwd?: string;
      /**
       * Which root `cwd` was declared against. `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` have
       * different permitted roots under §7.2.1, and the resolved absolute path alone no
       * longer says which — so the parser records what it already knew rather than making
       * the launcher guess from the string a second time.
       */
      cwdRoot?: 'plugin' | 'data';
      /**
       * Present only for a config parsed from a plugin. A hand-written config has no
       * plugin root, so it correctly receives no `PLUGIN_*` variables.
       */
      pluginRoot?: string;
      pluginDataRoot?: string;
    }
  | {
      name: string;
      type: 'streamable-http';
      url: string;
      headers?: Record<string, string>;
    }
  | {
      name: string;
      type: 'sse';
      url: string;
      headers?: Record<string, string>;
    };

export interface LoadAgentPluginOptions {
  /**
   * Host-registered tool names. When omitted, the flow validator's tools index
   * kind is absent — gated semantics skip tool-reference checks rather than
   * failing every action node. An empty array still enables the check class.
   */
  hostTools?: readonly string[];
}

export interface LoadedPlugin {
  manifest: PluginManifest;
  skills: SkillStoreLike;
  mcpServers: readonly McpServerConfig[];
  /** Validated definitions. The host registers them via `runtime.addDynamicFlows`. */
  flows: readonly FlowDefinition[];
  diagnostics: readonly Diagnostic[];
}

export type LoadPluginResult =
  | { ok: true; plugin: LoadedPlugin }
  | { ok: false; rejection: Rejection; diagnostics: readonly Diagnostic[] };
