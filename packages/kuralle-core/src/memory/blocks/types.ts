/**
 * Persistent memory blocks — file-backed (or pluggable) named memory
 * the agent edits via a single `memory_block` tool.
 *
 * Design summary (researched against AI SDK docs example
 * `nicoalbanese/ai-sdk-memory-just-bash`, Hermes's MEMORY.md/USER.md,
 * Letta's core memory blocks):
 *
 *   - Two layers: a STORE (load/save/list) + a TOOL (LLM-facing).
 *   - Blocks are short markdown documents. Default conventions:
 *       USER.md   — what the agent knows about the user
 *       MEMORY.md — agent's own notes about itself / its environment
 *     But the interface is generic — apps can define more blocks.
 *   - Char-limit-based (model-independent), not token-limit.
 *   - Frozen-snapshot pattern at the runtime layer (NOT enforced here):
 *     loaded into session.workingMemory once per session; mid-session
 *     writes update DISK immediately but don't change the system prompt
 *     until next session. This preserves Anthropic prompt-cache hits.
 */

/** Allowed scopes for a block. */
export type MemoryBlockScope = 'user' | 'agent' | 'shared';

/** One persistent memory block. */
export interface PersistentMemoryBlock {
  /** Key within its scope — e.g. 'USER', 'MEMORY', 'project-notes'. */
  key: string;
  /** Which scope this block belongs to. */
  scope: MemoryBlockScope;
  /** Raw markdown content (free-form; entries separated by `§` or `---`). */
  content: string;
  /** Max characters for this block. Writes exceeding this are rejected. */
  charLimit: number;
  /** When this block was last written (ISO8601 string). */
  updatedAt?: string;
}

/**
 * Storage adapter for persistent memory blocks. Implementations:
 *   - `FilePersistentMemoryStore` (built-in default, file-system backed)
 *   - postgres / redis / vector — pluggable via this interface
 *
 * The store is responsible for atomic durability and per-user/per-agent
 * scoping; the runtime layer handles when to load + when to inject.
 */
export interface PersistentMemoryStore {
  /**
   * Load a single block by (scope, owner, key). Returns null when the
   * block does not exist yet (first time the agent ever ran for this
   * owner). Implementations MUST NOT throw on missing — return null.
   *
   * `owner` is typically the userId for scope='user' / scope='shared',
   * and the agentId for scope='agent'. Implementations should accept any
   * string and treat it as opaque.
   */
  loadBlock(scope: MemoryBlockScope, owner: string, key: string): Promise<PersistentMemoryBlock | null>;

  /** Persist a block atomically. Replaces the entire content. */
  saveBlock(block: PersistentMemoryBlock, owner: string): Promise<void>;

  /** Delete a block. No-op when missing. */
  deleteBlock(scope: MemoryBlockScope, owner: string, key: string): Promise<void>;

  /** List block keys for an owner within a scope. */
  listBlocks(scope: MemoryBlockScope, owner: string): Promise<string[]>;
}

/** Runtime configuration for persistent memory. */
export interface PersistentMemoryConfig {
  /** The store backend. Defaults to FilePersistentMemoryStore when omitted. */
  store?: PersistentMemoryStore;
  /**
   * Which blocks to auto-load at session start and inject into the system
   * prompt. Defaults: `[{ scope: 'user', key: 'USER' }, { scope: 'agent', key: 'MEMORY' }]`.
   * Set to `[]` to disable auto-injection (the tool is still available).
   */
  autoLoad?: Array<{ scope: MemoryBlockScope; key: string }>;
  /** Default character limit per block when not specified at write time. */
  defaultCharLimit?: number;
  /** When true (default), reject writes whose content matches a prompt-injection pattern. */
  scanForInjection?: boolean;
}

export const DEFAULT_BLOCK_CHAR_LIMIT = 10_000;

export const DEFAULT_AUTO_LOAD_BLOCKS: Array<{ scope: MemoryBlockScope; key: string }> = [
  { scope: 'user', key: 'USER' },
  { scope: 'agent', key: 'MEMORY' },
];
