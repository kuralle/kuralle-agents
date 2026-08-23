import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  MemorySessionEventLog,
  readMemory,
  resolveExtractedValueStore,
  resolveWorkingMemoryStore,
  type AgentConfig,
  type ExtractedValueStore,
  type MemoryBlockScope,
  type PersistentMemoryStore,
  type RouteOutcome,
  type SessionRouteDeps,
} from '@kuralle-agents/core';

function isAgentConfig(value: unknown): value is AgentConfig {
  return (
    typeof value === 'object'
    && value !== null
    && typeof (value as AgentConfig).id === 'string'
    && 'instructions' in value
  );
}

function isExtractedValueStore(value: unknown): value is ExtractedValueStore {
  return (
    typeof value === 'object'
    && value !== null
    && typeof (value as ExtractedValueStore).load === 'function'
    && typeof (value as ExtractedValueStore).save === 'function'
  );
}

export interface AgentMemoryContext {
  agent: AgentConfig;
  extractedValueStore: ExtractedValueStore;
  defaultWorkingMemoryStore?: PersistentMemoryStore;
}

export async function resolveAgentMemoryContext(agentPath: string): Promise<AgentMemoryContext | undefined> {
  const abs = resolve(agentPath);
  const mod = (await import(pathToFileURL(abs).href)) as Record<string, unknown>;
  const agent = ('agent' in mod && isAgentConfig(mod.agent))
    ? mod.agent
    : ('default' in mod && isAgentConfig(mod.default))
      ? mod.default
      : undefined;
  if (!agent) return undefined;

  const extractedValueStore = ('extractedValueStore' in mod && isExtractedValueStore(mod.extractedValueStore))
    ? mod.extractedValueStore
    : resolveExtractedValueStore(undefined);
  const defaultWorkingMemoryStore = ('defaultWorkingMemoryStore' in mod
    && typeof mod.defaultWorkingMemoryStore === 'object'
    && mod.defaultWorkingMemoryStore !== null
    && typeof (mod.defaultWorkingMemoryStore as PersistentMemoryStore).loadBlock === 'function')
    ? mod.defaultWorkingMemoryStore as PersistentMemoryStore
    : undefined;

  return { agent, extractedValueStore, defaultWorkingMemoryStore };
}

function buildMemoryDeps(
  blockStore: PersistentMemoryStore | undefined,
  extractedStore: ExtractedValueStore,
  memoryConfig: AgentConfig['memory'],
  userOwner: string,
  agentOwner: string,
): SessionRouteDeps['memory'] {
  return {
    readBlocks: async () => {
      const blocks: Array<{ key: string; scope: string; content: string; charLimit: number }> = [];
      if (!blockStore) return blocks;
      const scopes: Array<{ scope: MemoryBlockScope; owner: string }> = [
        { scope: 'user', owner: userOwner },
        { scope: 'shared', owner: userOwner },
        { scope: 'agent', owner: agentOwner },
      ];
      for (const { scope, owner } of scopes) {
        const keys = await blockStore.listBlocks(scope, owner);
        for (const key of keys) {
          const block = await blockStore.loadBlock(scope, owner, key);
          if (!block) continue;
          blocks.push({
            key: block.key,
            scope: block.scope,
            content: block.content,
            charLimit: block.charLimit,
          });
        }
      }
      return blocks;
    },
    readExtracted: async () => {
      const extracted: Array<{ slug: string; scope: string; value: unknown; updatedAt: string }> = [];
      for (const extractor of memoryConfig?.extract ?? []) {
        const owner = extractor.scope === 'agent' ? agentOwner : userOwner;
        const value = await extractedStore.load(extractor.scope, owner, extractor.slug);
        if (!value) continue;
        extracted.push({
          slug: value.slug,
          scope: value.scope,
          value: value.value,
          updatedAt: value.updatedAt,
        });
      }
      return extracted;
    },
  };
}

export async function readLocalMemory(
  context: AgentMemoryContext,
  userId: string,
): Promise<RouteOutcome> {
  const workingMemory = context.agent.memory?.workingMemory;
  const blockStore = workingMemory
    ? resolveWorkingMemoryStore(workingMemory, context.defaultWorkingMemoryStore)
    : undefined;
  const deps: SessionRouteDeps = {
    eventLog: new MemorySessionEventLog(),
    memory: buildMemoryDeps(
      blockStore,
      context.extractedValueStore,
      context.agent.memory,
      userId,
      context.agent.id,
    ),
    cancelTurn: async () => 'no_active_turn',
    memoryOwner: (_principal, requestedUserId) => requestedUserId,
  };
  return readMemory(deps, { tenantId: 'local', userId }, userId);
}
