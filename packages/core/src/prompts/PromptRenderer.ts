/**
 * PromptRenderer — Pure functions that render resolved prompt sections to a string.
 *
 * Handles XML tag wrapping, token budgeting (trimming shrinkable sections in
 * reverse priority order), and security validation.
 *
 * @module
 */

import { estimateTokenCount, truncateToTokenBudget } from '../runtime/ContextBudget.js';
import type { ResolvedSection } from './PromptAssembly.js';

// ============================================
// Types
// ============================================

/**
 * Options controlling how resolved sections are rendered to a final string.
 */
export interface RenderOptions {
  /** Maximum token budget for the rendered prompt. If exceeded, shrinkable sections are trimmed. */
  maxTokens?: number;
  /** Whether to wrap each section in XML tags. Defaults to true. */
  useXmlTags?: boolean;
  /** Whether to validate that security sections (security_core, security_reminder) exist. Defaults to true. */
  validateSecurity?: boolean;
}

// ============================================
// Error
// ============================================

/**
 * Thrown when prompt validation fails (e.g. missing security sections).
 */
export class PromptValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PromptValidationError';
  }
}

// ============================================
// Render
// ============================================

/**
 * Renders an array of resolved sections into a single prompt string.
 *
 * Behavior:
 * 1. Filters out sections with empty content.
 * 2. Validates that security sections exist (if `validateSecurity` is true).
 * 3. If total tokens exceed `maxTokens`, trims shrinkable sections in
 *    **reverse** priority order (lowest priority trimmed first — so knowledge,
 *    memory, and tools are trimmed before role/instructions).
 * 4. Wraps each section in `<tag>\ncontent\n</tag>` when `useXmlTags` is true.
 *
 * @param sections - Pre-sorted resolved sections (ascending priority).
 * @param options  - Render options.
 * @returns The assembled prompt string.
 */
export function renderSections(
  sections: ResolvedSection[],
  options: RenderOptions = {},
): string {
  const {
    maxTokens,
    useXmlTags = true,
    validateSecurity = true,
  } = options;

  // Filter empty sections
  let active = sections.filter((s) => s.content.trim().length > 0);

  // Validate security
  if (validateSecurity) {
    const hasSecurityCore = active.some((s) => s.type === 'security_core');
    const hasSecurityReminder = active.some((s) => s.type === 'security_reminder');

    if (!hasSecurityCore) {
      throw new PromptValidationError(
        'Missing required security_core section. ' +
          'Disable security validation with { validateSecurity: false } if intentional.',
      );
    }
    if (!hasSecurityReminder) {
      throw new PromptValidationError(
        'Missing required security_reminder section. ' +
          'Disable security validation with { validateSecurity: false } if intentional.',
      );
    }
  }

  // Token budgeting — trim shrinkable sections in reverse priority order
  if (maxTokens && maxTokens > 0) {
    active = applyTokenBudget(active, maxTokens);
  }

  // Render each section
  const rendered = active.map((section) => {
    if (useXmlTags) {
      return `<${section.tag}>\n${section.content}\n</${section.tag}>`;
    }
    return section.content;
  });

  return rendered.join('\n\n');
}

// ============================================
// Internal
// ============================================

/**
 * Applies token budgeting by trimming shrinkable sections.
 *
 * Strategy: iterate sections from lowest priority (highest priority number)
 * to highest priority (lowest priority number). For each shrinkable section
 * whose removal or truncation would bring the total under budget, truncate it.
 */
function applyTokenBudget(
  sections: ResolvedSection[],
  maxTokens: number,
): ResolvedSection[] {
  let totalTokens = sections.reduce((sum, s) => sum + s.estimatedTokens, 0);

  if (totalTokens <= maxTokens) return sections;

  // Work on a mutable copy, iterate from lowest priority (end) to highest (start).
  const result = [...sections];

  // Build indices sorted by priority descending (lowest priority = highest number first)
  const indices = result
    .map((_, i) => i)
    .sort((a, b) => result[b].priority - result[a].priority);

  for (const idx of indices) {
    if (totalTokens <= maxTokens) break;

    const section = result[idx];
    if (!section.shrinkable) continue;

    const excess = totalTokens - maxTokens;
    const newBudget = Math.max(0, section.estimatedTokens - excess);

    if (newBudget <= 0) {
      // Remove the section entirely
      totalTokens -= section.estimatedTokens;
      result[idx] = { ...section, content: '', estimatedTokens: 0 };
    } else {
      // Truncate to remaining budget
      const truncated = truncateToTokenBudget(section.content, newBudget);
      const newTokens = estimateTokenCount(truncated);
      totalTokens -= section.estimatedTokens - newTokens;
      result[idx] = { ...section, content: truncated, estimatedTokens: newTokens };
    }
  }

  // Filter out emptied sections
  return result.filter((s) => s.content.trim().length > 0);
}
