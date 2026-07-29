import type { AgentConfig } from '../types/agentConfig.js';
import type { Session } from '../types/session.js';
import type { AnyTool } from '../types/effectTool.js';
import type { PersistentMemoryStore } from '../memory/blocks/types.js';
import { createFsTool } from '../tools/fs/createFsTool.js';
import { createShellTool } from '../tools/fs/createShellTool.js';
import { wireAgentSkills } from '../skills/wireAgentSkills.js';
import type { KnowledgeProvider } from './KnowledgeProvider.js';
import { buildKnowledgeTool, wireWorkingMemory } from './grounding/index.js';
import {
  resolveAgentWorkspaceForSession,
  type ResolvedAgentWorkspace,
} from './resolveAgentWorkspace.js';

export interface AgentToolSurface {
  executorTools: Record<string, AnyTool>;
  globalTools: Record<string, AnyTool>;
  workingMemoryTools?: Record<string, AnyTool>;
  workingMemoryPrompt?: string;
  skillPrompt?: string;
  skillContentHash?: string;
  resolvedWorkspace?: ResolvedAgentWorkspace;
}

export interface BuildAgentToolSurfaceDeps {
  configTools?: Record<string, AnyTool>;
  knowledgeProvider?: KnowledgeProvider;
  defaultWorkingMemoryStore?: PersistentMemoryStore;
}

export async function buildAgentToolSurface(
  agent: AgentConfig,
  session: Session,
  deps: BuildAgentToolSurfaceDeps,
): Promise<AgentToolSurface> {
  const executorTools: Record<string, AnyTool> = {
    ...(deps.configTools ?? {}),
    ...(agent.tools ?? {}),
    ...(agent.globalTools ?? {}),
  };

  const resolvedWorkspace = await resolveAgentWorkspaceForSession(agent.workspace, {
    session,
    agentId: agent.id,
  });
  let workspaceTool: AnyTool | undefined;
  let modelWorkspaceTool: AnyTool | undefined;
  if (resolvedWorkspace) {
    workspaceTool = createFsTool({
      fs: resolvedWorkspace.fs,
      readOnly: resolvedWorkspace.readOnly,
      instructions: resolvedWorkspace.instructions,
    });
    executorTools.workspace = workspaceTool;
    modelWorkspaceTool = resolvedWorkspace.readOnly || resolvedWorkspace.modelWritable
      ? workspaceTool
      : createFsTool({
          fs: resolvedWorkspace.fs,
          readOnly: true,
          instructions: resolvedWorkspace.instructions,
        });
  }

  if (resolvedWorkspace?.shell) {
    executorTools.bash = createShellTool({ shell: resolvedWorkspace.shell });
  }

  const wiredWorkingMemory = await wireWorkingMemory(
    agent,
    session,
    deps.defaultWorkingMemoryStore,
  );
  if (wiredWorkingMemory) {
    executorTools.memory_block = wiredWorkingMemory.memoryBlockTool;
  }

  let skillPrompt: string | undefined;
  let skillContentHash: string | undefined;
  let skillTools: Record<string, AnyTool> = {};
  if (agent.skills) {
    const wired = await wireAgentSkills(agent, resolvedWorkspace?.fs);
    if (wired) {
      skillTools = wired.tools;
      Object.assign(executorTools, wired.tools);
      skillPrompt = wired.promptSections.map((s) => s.content).join('\n\n');
      skillContentHash = wired.contentHash;
    }
  }

  const knowledgeTool = deps.knowledgeProvider
    ? buildKnowledgeTool(deps.knowledgeProvider, agent)
    : undefined;
  if (knowledgeTool) {
    executorTools.knowledge_search = knowledgeTool;
  }

  const globalTools: Record<string, AnyTool> = {
    ...(agent.globalTools ?? {}),
    ...(modelWorkspaceTool ? { workspace: modelWorkspaceTool } : {}),
    ...skillTools,
    ...(knowledgeTool ? { knowledge_search: knowledgeTool } : {}),
  };

  return {
    executorTools,
    globalTools,
    workingMemoryPrompt: wiredWorkingMemory?.promptSection,
    workingMemoryTools: wiredWorkingMemory
      ? { memory_block: wiredWorkingMemory.memoryBlockTool }
      : undefined,
    skillPrompt,
    skillContentHash,
    resolvedWorkspace,
  };
}
