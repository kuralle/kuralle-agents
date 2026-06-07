import type { FileSystem } from '../types/filesystem.js';

export type AgentWorkspaceConfig =
  | FileSystem
  | { fs: FileSystem; readOnly?: boolean };

export interface ResolvedAgentWorkspace {
  fs: FileSystem;
  readOnly: boolean;
}

export function resolveAgentWorkspace(
  workspace: AgentWorkspaceConfig | undefined,
): ResolvedAgentWorkspace | undefined {
  if (!workspace) {
    return undefined;
  }
  if (typeof workspace === 'object' && workspace !== null && 'fs' in workspace) {
    return { fs: workspace.fs, readOnly: workspace.readOnly !== false };
  }
  return { fs: workspace as FileSystem, readOnly: true };
}
