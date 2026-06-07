import type { AgentConfig } from '../../types/agentConfig.js';
import type { WorkingMemoryBlockSpec, WorkingMemoryConfig } from '../../types/grounding.js';
import type { Session } from '../../types/session.js';
import type { AnyTool } from '../../types/effectTool.js';
import { buildMemoryBlockTool } from '../../memory/blocks/memoryBlockTool.js';
import {
  DEFAULT_AUTO_LOAD_BLOCKS,
  DEFAULT_BLOCK_CHAR_LIMIT,
  type MemoryBlockScope,
  type PersistentMemoryStore,
} from '../../memory/blocks/types.js';
import { wrapAiSdkTool } from '../../tools/effect/wrapAiSdkTool.js';
import { getNodeDefaultWorkingMemoryStore } from './defaultStoreRegistry.js';

export interface LoadedWorkingMemoryBlock {
  scope: MemoryBlockScope;
  key: string;
  content: string;
}

export interface WiredWorkingMemory {
  promptSection: string | undefined;
  memoryBlockTool: AnyTool;
}

export function resolveWorkingMemoryStore(
  config: WorkingMemoryConfig,
  harnessDefault?: PersistentMemoryStore,
): PersistentMemoryStore {
  if (config.store) {
    return config.store;
  }
  if (harnessDefault) {
    return harnessDefault;
  }
  const factory = getNodeDefaultWorkingMemoryStore();
  if (factory) {
    return factory();
  }
  throw new Error(
    '[Kuralle] agent.memory.workingMemory requires a store. Pass workingMemory.store, ' +
      'HarnessConfig.defaultWorkingMemoryStore, or import FilePersistentMemoryStore on Node.',
  );
}

export function resolveWorkingMemoryOwner(
  scope: MemoryBlockScope,
  agentId: string,
  userId: string | undefined,
): string {
  return scope === 'agent' ? agentId : (userId ?? 'anonymous');
}

export async function loadWorkingMemoryBlocks(
  store: PersistentMemoryStore,
  autoLoad: WorkingMemoryBlockSpec[],
  resolveOwner: (scope: MemoryBlockScope) => string,
): Promise<LoadedWorkingMemoryBlock[]> {
  const loaded: LoadedWorkingMemoryBlock[] = [];
  for (const spec of autoLoad) {
    const owner = resolveOwner(spec.scope);
    const block = await store.loadBlock(spec.scope, owner, spec.key);
    let content = block?.content?.trim() ?? '';
    if (!content && spec.template) {
      content = spec.template.trim();
    }
    if (content) {
      loaded.push({ scope: spec.scope, key: spec.key, content });
    }
  }
  return loaded;
}

export function formatWorkingMemorySection(
  blocks: LoadedWorkingMemoryBlock[],
  autoLoad: WorkingMemoryBlockSpec[],
): string | undefined {
  if (autoLoad.length === 0) {
    return undefined;
  }
  const byKey = new Map(blocks.map((b) => [`${b.scope}/${b.key}`, b]));
  // Directive (Mastra-informed): the model must proactively maintain these blocks
  // via the `memory_block` tool, not just read them. Rendered even when blocks are
  // empty so a first-time conversation knows the capability exists.
  const lines = [
    '## Working memory',
    '',
    'You keep durable notes about the user and conversation in the blocks below, persisted across sessions. Use the `memory_block` tool to keep them current:',
    '- When the user shares a durable fact or preference (name, account details, preferences, anything that may be referenced again), call `memory_block` with action `add`, the relevant block, and a short factual entry. Store proactively — if unsure whether it will matter later, store it.',
    '- Answer questions about stored information from these blocks first; you do NOT need to call the tool to read them.',
    '- Do not announce that you are saving, and do not call the tool when nothing relevant changed.',
    '',
  ];
  for (const spec of autoLoad) {
    const block = byKey.get(`${spec.scope}/${spec.key}`);
    lines.push(`### ${spec.key} (${spec.scope})`);
    lines.push(block?.content?.trim() || '(empty — add entries here as you learn them)');
    lines.push('');
  }
  return lines.join('\n').trim();
}

export async function wireWorkingMemory(
  agent: AgentConfig,
  session: Session,
  harnessDefaultStore?: PersistentMemoryStore,
): Promise<WiredWorkingMemory | undefined> {
  const config = agent.memory?.workingMemory;
  if (!config) {
    return undefined;
  }

  const store = resolveWorkingMemoryStore(config, harnessDefaultStore);
  const autoLoad = config.autoLoad ?? DEFAULT_AUTO_LOAD_BLOCKS;
  const charLimit = config.defaultCharLimit ?? DEFAULT_BLOCK_CHAR_LIMIT;
  const resolveOwner = (scope: MemoryBlockScope) =>
    resolveWorkingMemoryOwner(scope, agent.id, session.userId);

  const loaded = await loadWorkingMemoryBlocks(store, autoLoad, resolveOwner);
  const promptSection = formatWorkingMemorySection(loaded, autoLoad);
  const memoryBlockTool = wrapAiSdkTool(
    'memory_block',
    buildMemoryBlockTool({
      store,
      resolveOwner,
      charLimit,
      scanForInjection: config.scanForInjection,
    }),
  );

  return { promptSection, memoryBlockTool };
}
