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
import { scanMemoryWrite } from './safetyScanner.js';
import {
  type PersistentMemoryStore,
  type MemoryBlockScope,
  DEFAULT_BLOCK_CHAR_LIMIT,
} from './types.js';

export interface MemoryBlockToolOptions {
  store: PersistentMemoryStore;
  /** Resolved per-session: how to scope writes (typically userId / agentId). */
  resolveOwner: (scope: MemoryBlockScope) => string;
  /** Per-block char limit (default 10,000). */
  charLimit?: number;
  /** When false, skip the prompt-injection scanner (NOT recommended). */
  scanForInjection?: boolean;
}

const inputSchema = z.object({
  action: z
    .enum(['view', 'add', 'replace', 'remove'])
    .describe(
      "What to do. 'view' returns the current content. 'add' appends a new entry (separated by a §). 'replace' substitutes the entire block. 'remove' deletes entries whose substring matches `match`.",
    ),
  block: z
    .string()
    .min(1)
    .max(64)
    .describe(
      "Block name. Common conventions: 'USER' (what you know about the user — scope=user), 'MEMORY' (your own notes — scope=agent).",
    ),
  scope: z
    .enum(['user', 'agent', 'shared'])
    .optional()
    .describe(
      "Storage scope. Defaults: 'user' for USER, 'agent' for MEMORY, 'shared' otherwise. Override only when you have a specific reason.",
    ),
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

type Input = z.infer<typeof inputSchema>;

const ENTRY_DELIM = '\n§\n';

function defaultScopeFor(block: string): MemoryBlockScope {
  if (block === 'USER') return 'user';
  if (block === 'MEMORY') return 'agent';
  return 'shared';
}

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

export function buildMemoryBlockTool(opts: MemoryBlockToolOptions) {
  const charLimit = opts.charLimit ?? DEFAULT_BLOCK_CHAR_LIMIT;
  const scanForInjection = opts.scanForInjection !== false;

  return tool({
    description:
      'Read or update a persistent memory block. Persistent blocks survive across sessions — use them to remember facts about the user (USER block) or yourself / your environment (MEMORY block). Keep entries short and factual.',
    inputSchema,
    async execute(input: Input) {
      const scope = input.scope ?? defaultScopeFor(input.block);
      const owner = opts.resolveOwner(scope);

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
  });
}
