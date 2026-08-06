import type { MemoryBlockScope } from '../blocks/types.js';

/**
 * A schema-validated value produced by an extractor.
 *
 * Deliberately NOT a `PersistentMemoryBlock`. A block is markdown the model
 * maintains under a character limit; this is typed JSON the runtime owns and
 * validates against a Zod schema. Sharing the block type would mean inventing a
 * `charLimit` on every write and calling JSON "raw markdown content" — the type
 * would not fit, which is the signal that it is the wrong type.
 *
 * They also differ on every axis that matters: writer (runtime vs model), shape
 * (typed JSON vs markdown), validity (schema vs char limit + safety scan),
 * consumer (prior-value prompt and `onExtracted` vs the system prompt), and
 * mutability (integrity-critical vs model-editable by design).
 */
export interface ExtractedValue<T = unknown> {
  /** Stable kebab-case slug derived from the extractor's name. */
  slug: string;
  /** Ownership dimension only — the same meaning it has on a block. */
  scope: MemoryBlockScope;
  /** The validated value. Serialization is the store's business, not the caller's. */
  value: T;
  /** ISO8601. */
  updatedAt: string;
}

/**
 * Storage for extractor output.
 *
 * There is deliberately no `list()`. Extractors are addressed by slug from
 * config and never enumerated; `PersistentMemoryStore.listBlocks` has no
 * production consumer either (only the Routed and Tiered composers forward it).
 * Omitting it removes a method and the mixed-enumeration problem that a shared
 * namespace would have created.
 *
 * `owner` is the userId for `user`/`shared` scope and the agentId for `agent`
 * scope, resolved by the caller. A caller that cannot resolve one must not
 * invent a placeholder — see `resolveWorkingMemoryOwner`, where a shared
 * `'anonymous'` fallback pooled every userless session into one bucket.
 */
export interface ExtractedValueStore {
  /** Returns null when nothing has been extracted for this slug yet. Never throws on missing. */
  load(scope: MemoryBlockScope, owner: string, slug: string): Promise<ExtractedValue | null>;
  /** Replaces any existing value for `(scope, owner, slug)`. */
  save(value: ExtractedValue, owner: string): Promise<void>;
  /** No-op when missing. */
  delete(scope: MemoryBlockScope, owner: string, slug: string): Promise<void>;
}
