export interface Diagnostic {
  section: string;
  rule: string;
  origin: string;
}

export interface PluginRejection {
  section: string;
  rule: string;
}

export interface LoadedPlugin {
  ok: boolean;
  rejection?: PluginRejection;
  skills: string[];
  mcpServers: string[];
  diagnostics: Diagnostic[];
}

export function loadPlugin(_root: string): Promise<LoadedPlugin> {
  throw new Error('loader not implemented');
}
