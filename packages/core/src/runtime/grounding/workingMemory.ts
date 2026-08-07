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
import {
  isValidBlockKey,
  isValidOwner,
  withOwnerValidation,
} from '../../memory/blocks/ownerKey.js';
import { wrapAiSdkTool } from '../../tools/effect/wrapAiSdkTool.js';
import { getNodeDefaultWorkingMemoryStore } from './defaultStoreRegistry.js';
// Same warning the preload/ingest path uses, so a missing userId reports once
// per session across every memory surface rather than once per surface.
import { warnMissingUserId } from './memory.js';

export interface LoadedWorkingMemoryBlock {
  scope: MemoryBlockScope;
  key: string;
  content: string;
}

export interface WiredWorkingMemory {
  promptSection: string | undefined;
  memoryBlockTool: AnyTool;
}

/**
 * The one place a working-memory store is obtained, and therefore the one place
 * layer 1 belongs. Every store handed out here validates its owner and block key
 * before touching a backend.
 *
 * It is wrapped here rather than inside each backend class deliberately: a
 * backend constructed directly stays as permissive as it always was (its own
 * layers 2/3 make it collision-safe regardless), while everything that goes
 * through the framework — `wireWorkingMemory`, the `memory_block` tool, and any
 * consumer calling this exported function — gets the reject-and-throw guarantee.
 */
export function resolveWorkingMemoryStore(
  config: WorkingMemoryConfig,
  harnessDefault?: PersistentMemoryStore,
): PersistentMemoryStore {
  if (config.store) {
    return withOwnerValidation(config.store);
  }
  if (harnessDefault) {
    return withOwnerValidation(harnessDefault);
  }
  const factory = getNodeDefaultWorkingMemoryStore();
  if (factory) {
    return withOwnerValidation(factory());
  }
  throw new Error(
    '[Kuralle] agent.memory.workingMemory requires a store. Pass workingMemory.store, ' +
      'HarnessConfig.defaultWorkingMemoryStore, or import FilePersistentMemoryStore on Node.',
  );
}

/**
 * The owner a block is stored under, or `undefined` when there is nobody to
 * store it for.
 *
 * There is deliberately no fallback. This previously returned `'anonymous'`
 * when a session had no `userId`, which made every such session share one
 * owner — so one visitor's USER block loaded into the next visitor's system
 * prompt. `userId` is optional on `chatRouter` and the OpenAI-compat endpoint,
 * so that was reachable on any hosted chat surface that did not pass one.
 *
 * `runtime/grounding/memory.ts` already fails closed on a missing `userId` for
 * preload and ingest. This now matches it: absent owner means the block does
 * not exist for this session, not that it belongs to everyone.
 *
 * `agent` scope is unaffected — `agentId` is always present.
 */
export function resolveWorkingMemoryOwner(
  scope: MemoryBlockScope,
  agentId: string,
  userId: string | undefined,
): string | undefined {
  if (scope === 'agent') return agentId;
  // Falsy, not just undefined. `grounding/memory.ts` guards preload and ingest
  // with `if (!ctx.session.userId)`, so it already treats '' and null as absent;
  // an `=== undefined` check here would leave `userId: ''` a valid shared owner
  // and the two paths would disagree again. `chatRouter` forwards `body.userId`
  // with no guard at all, so both reach here from the wire. Whitespace-only is
  // absent too; a present id is returned unchanged rather than trimmed, so no
  // existing owner is silently rewritten.
  return userId && userId.trim() ? userId : undefined;
}

export async function loadWorkingMemoryBlocks(
  store: PersistentMemoryStore,
  autoLoad: WorkingMemoryBlockSpec[],
  resolveOwner: (scope: MemoryBlockScope) => string | undefined,
): Promise<LoadedWorkingMemoryBlock[]> {
  const loaded: LoadedWorkingMemoryBlock[] = [];
  for (const spec of autoLoad) {
    const owner = resolveOwner(spec.scope);
    if (owner === undefined) {
      // No owner means this block does not exist for this session. Reading it
      // under a placeholder would read somebody else's.
      continue;
    }
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

const CHARSET_HINT = '[A-Za-z0-9._@+:~|-]';

const warnedInvalidKeySessions = new Set<string>();
const warnedInvalidOwnerSessions = new Set<string>();

function warnInvalidBlockKeys(sessionId: string, keys: string[]): void {
  if (warnedInvalidKeySessions.has(sessionId)) {
    return;
  }
  warnedInvalidKeySessions.add(sessionId);
  console.warn(
    `[Kuralle] working-memory block key(s) ${JSON.stringify(keys)} contain characters ` +
      `outside ${CHARSET_HINT} and were withheld from this session. Rename them in ` +
      'agent.memory.workingMemory.autoLoad.',
  );
}

function warnInvalidOwner(sessionId: string, owners: string[]): void {
  if (warnedInvalidOwnerSessions.has(sessionId)) {
    return;
  }
  warnedInvalidOwnerSessions.add(sessionId);
  console.warn(
    `[Kuralle] working-memory owner(s) ${JSON.stringify(owners)} contain characters outside ` +
      `${CHARSET_HINT}. Those blocks were withheld from this session rather than stored ` +
      'under a key that could collide with another owner. The userId is present but ' +
      'unusable — sanitise it upstream, do not pass raw path- or separator-bearing ids.',
  );
}

/** Test seam: the warn-once caches are process-global by design. */
export function resetWorkingMemoryWarningsForTests(): void {
  warnedInvalidKeySessions.clear();
  warnedInvalidOwnerSessions.clear();
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

  // Already owner-validating — `resolveWorkingMemoryStore` wraps every store it
  // hands out, so `loadWorkingMemoryBlocks` below and the `memory_block` tool
  // both get the guarantee without a second wrap here.
  const store = resolveWorkingMemoryStore(config, harnessDefaultStore);
  const declared = config.autoLoad ?? DEFAULT_AUTO_LOAD_BLOCKS;
  const charLimit = config.defaultCharLimit ?? DEFAULT_BLOCK_CHAR_LIMIT;
  const resolveOwner = (scope: MemoryBlockScope) => {
    const owner = resolveWorkingMemoryOwner(scope, agent.id, session.userId);
    // An owner outside the allow-list is unusable, not merely awkward: it is
    // the shape a bug produces. Treat it exactly as an unresolvable owner —
    // withhold the surface — rather than throwing through the middle of a turn.
    return owner !== undefined && isValidOwner(owner) ? owner : undefined;
  };

  // A block whose owner cannot be resolved is not this session's to read or
  // write. Drop it from the surface entirely rather than serving it under a
  // placeholder owner shared with every other anonymous session.
  //
  // The two reasons get different warnings on purpose. "No userId" and "the
  // userId you sent is malformed" have opposite fixes, and reporting the second
  // as the first sends an operator looking for a value that is already there.
  const addressable = declared.filter((spec) => resolveOwner(spec.scope) !== undefined);
  if (addressable.length < declared.length) {
    const rawOwners = declared
      .filter((spec) => resolveOwner(spec.scope) === undefined)
      .map((spec) => resolveWorkingMemoryOwner(spec.scope, agent.id, session.userId));
    if (rawOwners.some((owner) => owner === undefined)) {
      warnMissingUserId(session.id);
    }
    const malformed = rawOwners.filter((owner): owner is string => owner !== undefined);
    if (malformed.length > 0) {
      warnInvalidOwner(session.id, malformed);
    }
  }

  // A declared key outside the allow-list would reach a store that rejects it,
  // turning every write to that block into a thrown error mid-turn. Drop it at
  // wiring time and say so once, so the fault names its own cause.
  const autoLoad = addressable.filter((spec) => isValidBlockKey(spec.key));
  if (autoLoad.length < addressable.length) {
    warnInvalidBlockKeys(
      session.id,
      addressable.filter((spec) => !isValidBlockKey(spec.key)).map((spec) => spec.key),
    );
  }
  if (autoLoad.length === 0) {
    // Nothing addressable: no prompt section, and no tool to write with.
    return undefined;
  }

  const loaded = await loadWorkingMemoryBlocks(store, autoLoad, resolveOwner);
  const promptSection = formatWorkingMemorySection(loaded, autoLoad);
  const memoryBlockTool = wrapAiSdkTool(
    'memory_block',
    buildMemoryBlockTool({
      store,
      // Only the addressable blocks — an unaddressable one is not this
      // session's to write either.
      blocks: autoLoad,
      resolveOwner,
      charLimit,
      scanForInjection: config.scanForInjection,
    }),
  );

  return { promptSection, memoryBlockTool };
}
