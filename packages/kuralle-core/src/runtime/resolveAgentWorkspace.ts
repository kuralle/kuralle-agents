import type { FileSystem } from '../types/filesystem.js';
import type { Shell } from '../types/shell.js';

export type AgentWorkspaceConfig =
  | FileSystem
  | { fs: FileSystem; shell?: Shell; readOnly?: boolean };

export interface ResolvedAgentWorkspace {
  fs: FileSystem;
  shell?: Shell;
  readOnly: boolean;
}

export function resolveAgentWorkspace(
  workspace: AgentWorkspaceConfig | undefined,
): ResolvedAgentWorkspace | undefined {
  if (!workspace) {
    return undefined;
  }
  if (typeof workspace === 'object' && workspace !== null && 'fs' in workspace) {
    return {
      fs: workspace.fs,
      shell: workspace.shell,
      readOnly: workspace.readOnly !== false,
    };
  }
  return { fs: workspace as FileSystem, readOnly: true, shell: undefined };
}
