import type { MemoryBlockScope } from '../blocks/types.js';
import type { ExtractedValue, ExtractedValueStore } from './store.js';

/**
 * Default `ExtractedValueStore`: process memory, lost on restart.
 *
 * The composite key uses NUL as the separator. Every other candidate (`:`, `/`,
 * `|`) can occur inside a userId, which would let two distinct owners collide on
 * one map key — the exact class of defect the block stores still carry.
 */
export class InMemoryExtractedValueStore implements ExtractedValueStore {
  private readonly rows = new Map<string, ExtractedValue>();

  private id(scope: MemoryBlockScope, owner: string, slug: string): string {
    return `${scope}\u0000${owner}\u0000${slug}`;
  }

  async load(
    scope: MemoryBlockScope,
    owner: string,
    slug: string,
  ): Promise<ExtractedValue | null> {
    const row = this.rows.get(this.id(scope, owner, slug));
    // Cloned on the way out as well as in. A caller that mutates what it read
    // would otherwise rewrite the stored row in place, which no serializing
    // backend does — the in-memory store must not be the odd one out.
    return row ? structuredClone(row) : null;
  }

  async save(value: ExtractedValue, owner: string): Promise<void> {
    // DEEP clone. A spread is shallow, which leaves `value.value` — the part
    // that actually holds the extracted data — aliased to the caller's object,
    // so a later mutation silently rewrites the stored row. The persistent
    // backends serialize on write and cannot alias; this one has to do it
    // explicitly or it behaves differently from every other backend.
    this.rows.set(this.id(value.scope, owner, value.slug), structuredClone(value));
  }

  async delete(scope: MemoryBlockScope, owner: string, slug: string): Promise<void> {
    this.rows.delete(this.id(scope, owner, slug));
  }
}
