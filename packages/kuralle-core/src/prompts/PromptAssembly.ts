/**
 * PromptAssembly — Structured intermediate representation for prompt sections.
 *
 * Sections are stored in a Map keyed by type (except 'custom' which uses an array).
 * Security-band sections (priority 0-9 or 1000+) are frozen after `freeze()` is called.
 *
 * @module
 */

import { estimateTokenCount } from '../runtime/ContextBudget.js';

// ============================================
// Types
// ============================================

/**
 * Configuration for a single prompt section.
 * Content can be a static string or an async function for deferred resolution.
 */
export interface PromptSectionConfig {
  /** Section type identifier. */
  type: string;
  /** Static content string or async function that resolves to content. */
  content: string | (() => Promise<string>);
  /** Sort priority. Lower numbers appear first. */
  priority: number;
  /** Whether this section can be trimmed under token pressure. Defaults to true. */
  shrinkable?: boolean;
  /** XML tag name used when rendering. Defaults to the type value. */
  tag?: string;
  /** Origin of this section for debugging/auditing. */
  source?: 'developer' | 'runtime' | 'flow' | 'security';
}

/**
 * A fully resolved section with content materialized and metadata computed.
 */
export interface ResolvedSection {
  /** Section type identifier. */
  type: string;
  /** Resolved content string. */
  content: string;
  /** Sort priority. */
  priority: number;
  /** Whether this section can be trimmed under token pressure. */
  shrinkable: boolean;
  /** XML tag name. */
  tag: string;
  /** Origin of this section. */
  source: string;
  /** Whether this section is in a frozen security band. */
  frozen: boolean;
  /** Estimated token count of the content. */
  estimatedTokens: number;
}

/**
 * Debug information about the assembly's current state.
 */
export interface AssemblyDebugInfo {
  /** Per-section metadata. */
  sections: Array<{
    type: string;
    priority: number;
    tokens: number;
    source: string;
    shrinkable: boolean;
    frozen: boolean;
  }>;
  /** Total estimated tokens across all sections. */
  totalTokens: number;
}

// ============================================
// Error
// ============================================

/**
 * Thrown when an attempt is made to modify a frozen security-band section.
 */
export class PromptSecurityViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PromptSecurityViolationError';
  }
}

// ============================================
// Helpers
// ============================================

/** Returns true if the priority falls within a frozen security band. */
function isSecurityBand(priority: number): boolean {
  return priority <= 9 || priority >= 1000;
}

// ============================================
// PromptAssembly
// ============================================

/**
 * PromptAssembly is the structured intermediate representation for prompt construction.
 *
 * Sections are stored in a Map keyed by type. The special type `'custom'` is stored
 * in a separate array to allow multiple custom sections.
 *
 * After `freeze()` is called, sections in security bands (priority 0-9 or 1000+)
 * cannot be added, replaced, or removed.
 */
export class PromptAssembly {
  private readonly sections: Map<string, PromptSectionConfig> = new Map();
  private readonly customSections: PromptSectionConfig[] = [];
  private frozen = false;

  /**
   * Adds or replaces a section. Custom-type sections are always appended.
   *
   * @throws {PromptSecurityViolationError} If the assembly is frozen and the
   *   section's priority falls within a security band (0-9 or 1000+).
   */
  addSection(config: PromptSectionConfig): this {
    if (this.frozen && isSecurityBand(config.priority)) {
      throw new PromptSecurityViolationError(
        `Cannot modify section "${config.type}" at priority ${config.priority}: ` +
          'security-band sections are frozen.',
      );
    }

    if (config.type === 'custom') {
      this.customSections.push(config);
    } else {
      this.sections.set(config.type, config);
    }

    return this;
  }

  /**
   * Sugar for `addSection` with `source: 'runtime'`.
   */
  inject(
    type: string,
    content: string | (() => Promise<string>),
    options?: Partial<Omit<PromptSectionConfig, 'type' | 'content' | 'source'>>,
  ): this {
    return this.addSection({
      type,
      content,
      priority: options?.priority ?? 60,
      shrinkable: options?.shrinkable,
      tag: options?.tag,
      source: 'runtime',
    });
  }

  /**
   * Freezes the assembly, preventing modification of security-band sections.
   */
  freeze(): this {
    this.frozen = true;
    return this;
  }

  /**
   * Resolves all sections — materializing async content functions — and
   * returns them sorted by priority (ascending). Empty sections are filtered out.
   */
  async resolve(): Promise<ResolvedSection[]> {
    const allConfigs: PromptSectionConfig[] = [
      ...this.sections.values(),
      ...this.customSections,
    ];

    const resolved: ResolvedSection[] = [];

    for (const config of allConfigs) {
      const content =
        typeof config.content === 'function'
          ? await config.content()
          : config.content;

      if (!content || content.trim().length === 0) continue;

      resolved.push({
        type: config.type,
        content,
        priority: config.priority,
        shrinkable: config.shrinkable ?? true,
        tag: config.tag ?? config.type,
        source: config.source ?? 'developer',
        frozen: this.frozen && isSecurityBand(config.priority),
        estimatedTokens: estimateTokenCount(content),
      });
    }

    resolved.sort((a, b) => a.priority - b.priority);
    return resolved;
  }

  /**
   * Returns the raw section config for a given type, or `undefined` if not present.
   */
  sectionByType(type: string): PromptSectionConfig | undefined {
    return this.sections.get(type);
  }

  /**
   * Returns true if a section of the given type exists.
   */
  hasSection(type: string): boolean {
    if (type === 'custom') return this.customSections.length > 0;
    return this.sections.has(type);
  }

  /**
   * Returns debug information about the assembly's current state.
   * Resolves async content to compute accurate token estimates.
   */
  async debug(): Promise<AssemblyDebugInfo> {
    const resolved = await this.resolve();

    const sectionInfos = resolved.map((s) => ({
      type: s.type,
      priority: s.priority,
      tokens: s.estimatedTokens,
      source: s.source,
      shrinkable: s.shrinkable,
      frozen: s.frozen,
    }));

    const totalTokens = sectionInfos.reduce((sum, s) => sum + s.tokens, 0);

    return { sections: sectionInfos, totalTokens };
  }

  /** Number of sections (including custom sections). */
  get size(): number {
    return this.sections.size + this.customSections.length;
  }
}
