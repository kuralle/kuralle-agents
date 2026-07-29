import type { FileSystem } from '../types/filesystem.js';
import type { Shell } from '../types/shell.js';
import type {
  AgentWorkspaceConfig,
  AgentWorkspaceDefinition,
  AgentWorkspaceResolverContext,
} from '../types/agentConfig.js';

export interface ResolvedAgentWorkspace {
  fs: FileSystem;
  shell?: Shell;
  readOnly: boolean;
  modelWritable: boolean;
  instructions?: string;
}

export function resolveAgentWorkspace(
  workspace: AgentWorkspaceConfig | undefined,
): ResolvedAgentWorkspace | undefined {
  if (!workspace) {
    return undefined;
  }
  if (typeof workspace === 'function') {
    throw new Error(
      'A workspace resolver requires session context. Use resolveAgentWorkspaceForSession().',
    );
  }
  if (typeof workspace === 'object' && workspace !== null && 'fs' in workspace) {
    return {
      fs: workspace.fs,
      shell: workspace.shell,
      readOnly: workspace.readOnly !== false,
      modelWritable: workspace.modelWritable === true,
      instructions: workspace.instructions,
    };
  }
  return {
    fs: workspace as FileSystem,
    readOnly: true,
    modelWritable: false,
    shell: undefined,
  };
}

/** Resolve static and request-scoped workspaces through one runtime entrypoint. */
export async function resolveAgentWorkspaceForSession(
  workspace: AgentWorkspaceConfig | undefined,
  context: AgentWorkspaceResolverContext,
): Promise<ResolvedAgentWorkspace | undefined> {
  if (!workspace) return undefined;
  const definition = typeof workspace === 'function' ? await workspace(context) : workspace;
  return resolveAgentWorkspace(definition as AgentWorkspaceDefinition);
}
