import type { AgentConfig } from '../types/agentConfig.js';
import type { Session } from '../types/session.js';
import type { AnyTool } from '../types/effectTool.js';
import type { PersistentMemoryStore } from '../memory/blocks/types.js';
import type { ExtractedValueStore } from '../memory/extract/store.js';
import { createFsTool } from '../tools/fs/createFsTool.js';
import { createShellTool } from '../tools/fs/createShellTool.js';
import { wireAgentSkills } from '../skills/wireAgentSkills.js';
import type { SkillHandle } from '../skills/skillHandle.js';
import { LiveSkillCatalog } from '../skills/liveSkillCatalog.js';
import type { SkillLike, SkillMeta } from '../types/skills.js';
import type { KnowledgeProvider } from './KnowledgeProvider.js';
import { buildKnowledgeTool, wireWorkingMemory, wireSearchMemory } from './grounding/index.js';
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
  /** Live skill catalog — what `load_skill` resolves against, distinct from frozen `skillPrompt`. */
  skillCatalog?: LiveSkillCatalog;
  getSkill?: (name: string) => SkillHandle;
  skillMetaByName?: ReadonlyMap<string, SkillMeta>;
  resolvedWorkspace?: ResolvedAgentWorkspace;
  /** Present only when `agent.skills` contained a `SkillResolver`: this session's resolver
   *  output, by resolver position. The caller persists it (see `resolvedSkillsState.ts`) so
   *  the resolver runs once per session, not once per turn. */
  resolvedSkillSnapshot?: Record<string, SkillLike[]>;
}

export interface BuildAgentToolSurfaceDeps {
  configTools?: Record<string, AnyTool>;
  knowledgeProvider?: KnowledgeProvider;
  defaultWorkingMemoryStore?: PersistentMemoryStore;
  /** Store `search_memory` reads from. Absent means the tool is withheld entirely. */
  extractedValueStore?: ExtractedValueStore;
  /** This agent's previously resolved `SkillResolver` output for the session, if any —
   *  read from `runState.state.resolvedSkills` by the caller (`resolvedSkillsState.ts`). */
  resolvedSkillCache?: Readonly<Record<string, SkillLike[]>>;
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

  const searchMemoryTool = deps.extractedValueStore
    ? await wireSearchMemory(agent, session, deps.extractedValueStore)
    : undefined;
  if (searchMemoryTool) {
    executorTools.search_memory = searchMemoryTool;
  }

  let skillPrompt: string | undefined;
  let skillContentHash: string | undefined;
  let skillCatalog: LiveSkillCatalog | undefined;
  let getSkill: ((name: string) => SkillHandle) | undefined;
  let skillMetaByName: ReadonlyMap<string, SkillMeta> | undefined;
  let skillTools: Record<string, AnyTool> = {};
  let resolvedSkillSnapshot: Record<string, SkillLike[]> | undefined;
  if (agent.skills) {
    const wired = await wireAgentSkills(agent, resolvedWorkspace?.fs, {
      session,
      cached: deps.resolvedSkillCache,
    });
    if (wired) {
      skillTools = wired.tools;
      Object.assign(executorTools, wired.tools);
      skillPrompt = wired.promptSections.map((s) => s.content).join('\n\n');
      skillContentHash = wired.contentHash;
      skillCatalog = wired.catalog;
      getSkill = wired.getSkill;
      skillMetaByName = new Map(wired.metas.map((meta) => [meta.name, meta]));
      resolvedSkillSnapshot = wired.resolvedSkillsByIndex;
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
    // `search_memory` shares this channel with `memory_block` rather than a
    // new field: both are read/write surfaces over the memory subsystem, and
    // `resolveNodeTools`/`AiSdkModelTurnLoop` already give this channel the
    // right exposure — available at every node scope except 'closed'.
    workingMemoryTools:
      wiredWorkingMemory || searchMemoryTool
        ? {
            ...(wiredWorkingMemory ? { memory_block: wiredWorkingMemory.memoryBlockTool } : {}),
            ...(searchMemoryTool ? { search_memory: searchMemoryTool } : {}),
          }
        : undefined,
    skillPrompt,
    skillContentHash,
    skillCatalog,
    getSkill,
    skillMetaByName,
    resolvedWorkspace,
    resolvedSkillSnapshot,
  };
}
