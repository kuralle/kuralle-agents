/**
 * The LLM-facing `memory_block` tool.
 *
 * Single tool with an `action` discriminator (view/add/replace/remove) —
 * keeps the model's tool schema simple, matches the AI SDK docs example
 * pattern and Hermes's design. View is required even for read because
 * persistent blocks are NOT in the prompt (the FROZEN snapshot is); the
 * tool gives the agent a way to read its OWN latest writes mid-session.
 *
 * Char-limit + safety scanning are enforced here at the tool layer, so
 * the store stays a dumb persistence adapter and a future seed-script
 * or admin write can bypass them when intentional.
 */
import { z } from 'zod';
import { tool } from 'ai';
import type { AiSdkTool } from '../../tools/Tool.js';
import { scanMemoryWrite } from './safetyScanner.js';
import {
  type PersistentMemoryStore,
  type MemoryBlockScope,
  DEFAULT_BLOCK_CHAR_LIMIT,
} from './types.js';
import type { WorkingMemoryBlockSpec } from '../../types/grounding.js';

export interface MemoryBlockToolOptions {
  store: PersistentMemoryStore;
  /**
   * The blocks this agent declares. The model can address these and nothing
   * else — the tool's `block` argument is an enum built from this list, so an
   * undeclared name is not rejected at runtime, it cannot be expressed.
   *
   * Previously `block` was `z.string().min(1).max(64)` with a free-text
   * `scope`, which let the model create and overwrite arbitrary blocks in any
   * scope. Nothing consumed those: `loadWorkingMemoryBlocks` only injects
   * declared keys, so an ad-hoc block was never visible in a later session —
   * the model could create it and never find it again.
   */
  blocks: WorkingMemoryBlockSpec[];
  /** Owner for a scope, or `undefined` when this session has none (no userId).
   *  There is deliberately no placeholder — see `resolveWorkingMemoryOwner`. */
  resolveOwner: (scope: MemoryBlockScope) => string | undefined;
  /** Per-block char limit (default 10,000). */
  charLimit?: number;
  /** When false, skip the prompt-injection scanner (NOT recommended). */
  scanForInjection?: boolean;
}

function buildInputSchema(blockKeys: [string, ...string[]]) {
  return z.object({
    action: z
      .enum(['view', 'add', 'replace', 'remove'])
      .describe(
        "What to do. 'view' returns the current content. 'add' appends a new entry (separated by a §). 'replace' substitutes the entire block. 'remove' deletes entries whose substring matches `match`.",
      ),
    // The enum IS the documentation — the model sees exactly the blocks that
    // exist, so no prose is needed telling it which names are conventional.
    // Scope is not an input: it is implied by the block, which removes a second
    // free-text dimension the model could get wrong.
    block: z.enum(blockKeys).describe('Which block to act on.'),
    content: z
      .string()
      .optional()
      .describe("Content for 'add' or 'replace'. Required for those actions."),
    match: z
      .string()
      .optional()
      .describe(
        "For 'remove' only: substring to match against existing entries. Entries containing this substring are deleted.",
      ),
  });
}

type Input = z.infer<ReturnType<typeof buildInputSchema>>;

const ENTRY_DELIM = '\n§\n';

function appendEntry(existing: string, newEntry: string): string {
  if (!existing) return newEntry.trim();
  return `${existing.trimEnd()}${ENTRY_DELIM}${newEntry.trim()}`;
}

function removeMatchingEntries(existing: string, match: string): string {
  if (!existing) return '';
  const entries = existing.split(ENTRY_DELIM);
  const kept = entries.filter((e) => !e.includes(match));
  return kept.join(ENTRY_DELIM).trim();
}

export function buildMemoryBlockTool(opts: MemoryBlockToolOptions): AiSdkTool<Input, unknown> {
  const charLimit = opts.charLimit ?? DEFAULT_BLOCK_CHAR_LIMIT;
  const scanForInjection = opts.scanForInjection !== false;

  // One spec per key. Two declared blocks sharing a key across scopes would
  // make `block` ambiguous, so that is a config error rather than a silent
  // last-one-wins.
  const byKey = new Map<string, MemoryBlockScope>();
  for (const spec of opts.blocks) {
    const existing = byKey.get(spec.key);
    if (existing && existing !== spec.scope) {
      throw new Error(
        `[Kuralle] working-memory block "${spec.key}" is declared in both '${existing}' and ` +
          `'${spec.scope}' scope. Block names must be unique across scopes so the model can ` +
          `address one unambiguously.`,
      );
    }
    byKey.set(spec.key, spec.scope);
  }
  if (byKey.size === 0) {
    throw new Error('[Kuralle] buildMemoryBlockTool requires at least one declared block.');
  }
  const blockKeys = [...byKey.keys()] as [string, ...string[]];

  return tool({
    description:
      'Read or update a persistent memory block. Persistent blocks survive across sessions — use them to remember facts about the user or notes about yourself. Keep entries short and factual.',
    inputSchema: buildInputSchema(blockKeys),
    async execute(input: Input) {
      const scope = byKey.get(input.block)!;
      const owner = opts.resolveOwner(scope);
      if (owner === undefined) {
        // Defence in depth: `wireWorkingMemory` already withholds this tool when
        // no scope is addressable, so reaching here means a caller wired it
        // directly. Refuse rather than fall back to a shared placeholder owner.
        return {
          ok: false,
          block: input.block,
          scope,
          message: `No owner for scope '${scope}' in this session — memory is unavailable without a userId.`,
        };
      }

      if (input.action === 'view') {
        const block = await opts.store.loadBlock(scope, owner, input.block);
        if (!block) return { block: input.block, scope, content: '', empty: true };
        return {
          block: input.block,
          scope,
          content: block.content,
          updatedAt: block.updatedAt,
          chars: block.content.length,
        };
      }

      if (input.action === 'remove') {
        if (!input.match) {
          return { error: 'missing-match', message: "'remove' requires the `match` argument." };
        }
        const existing = await opts.store.loadBlock(scope, owner, input.block);
        if (!existing) return { ok: true, removed: 0, note: 'block-not-found' };
        const next = removeMatchingEntries(existing.content, input.match);
        if (next === existing.content) return { ok: true, removed: 0, note: 'no-match' };
        await opts.store.saveBlock(
          { key: input.block, scope, content: next, charLimit },
          owner,
        );
        const removed = existing.content.split(ENTRY_DELIM).length - next.split(ENTRY_DELIM).length;
        return { ok: true, removed, remainingChars: next.length };
      }

      // add / replace require content
      if (input.content === undefined || input.content === null) {
        return {
          error: 'missing-content',
          message: `'${input.action}' requires the \`content\` argument.`,
        };
      }

      // Safety scan
      if (scanForInjection) {
        const scan = scanMemoryWrite(input.content);
        if (!scan.safe) {
          return {
            error: 'unsafe-content',
            pattern: scan.matchedPattern,
            matched: scan.matchedText,
            message:
              'Refusing to persist content that matches a prompt-injection pattern. Rephrase or break into smaller factual entries.',
          };
        }
      }

      const existing = await opts.store.loadBlock(scope, owner, input.block);
      const nextContent =
        input.action === 'replace'
          ? input.content.trim()
          : appendEntry(existing?.content ?? '', input.content);

      if (nextContent.length > charLimit) {
        return {
          error: 'over-limit',
          chars: nextContent.length,
          limit: charLimit,
          message: `Block would be ${nextContent.length} chars, limit is ${charLimit}. Consolidate older entries (replace) or trim before adding.`,
        };
      }

      await opts.store.saveBlock(
        { key: input.block, scope, content: nextContent, charLimit },
        owner,
      );

      return {
        ok: true,
        action: input.action,
        block: input.block,
        scope,
        chars: nextContent.length,
        limit: charLimit,
      };
    },
  }) as AiSdkTool<Input, unknown>;
}
