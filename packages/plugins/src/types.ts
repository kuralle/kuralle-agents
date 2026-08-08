import type { SkillStoreLike } from '@kuralle-agents/core';

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
      command: string;
      args?: string[];
      env?: Record<string, string>;
      cwd?: string;
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

export interface LoadedPlugin {
  manifest: PluginManifest;
  skills: SkillStoreLike;
  mcpServers: readonly McpServerConfig[];
  diagnostics: readonly Diagnostic[];
}

export type LoadPluginResult =
  | { ok: true; plugin: LoadedPlugin }
  | { ok: false; rejection: Rejection; diagnostics: readonly Diagnostic[] };
