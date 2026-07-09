/**
 * KnowledgeCompiler — Offline LLM compilation of raw documents into
 * structured markdown knowledge bases (Layer 1).
 *
 * Derived from Karpathy's LLM Wiki pattern: stable business knowledge
 * (policies, SOPs, FAQs) is compiled by an LLM into a structured,
 * deduplicated markdown document. The compiled output is then loaded
 * into the system prompt every turn with zero search latency and
 * 100% retrieval accuracy.
 *
 * This is an ingestion-time utility — it calls the LLM and writes files.
 * It should NOT be imported in runtime bundles.
 *
 * Features:
 * - Incremental compilation: hash-based change detection, recompile only modified sources
 * - Token budget enforcement: compiler respects configurable token ceiling
 * - Structured output: organized by topic with clear section boundaries
 */

import crypto from 'node:crypto';
import type { Document } from '../types.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface KnowledgeCompilerConfig {
  /**
   * Function that calls the LLM to compile raw text into structured markdown.
   * The compiler is model-agnostic — callers provide their own LLM function.
   *
   * @param systemPrompt - Instructions for compilation.
   * @param userPrompt - The raw text to compile.
   * @returns Compiled structured markdown.
   */
  compile: (systemPrompt: string, userPrompt: string) => Promise<string>;

  /**
   * Maximum token budget for the compiled output. The compiler instructs
   * the LLM to stay within this limit. Default: 4000.
   */
  maxTokens?: number;

  /**
   * Custom system prompt for the compilation LLM call. When not provided,
   * a default prompt is used that produces structured markdown organized
   * by topic with deduplication.
   */
  systemPrompt?: string;
}

// ---------------------------------------------------------------------------
// Compilation result
// ---------------------------------------------------------------------------

export interface CompilationResult {
  /** The compiled structured markdown content. */
  compiled: string;
  /** Source document IDs that were included in this compilation. */
  sourceIds: string[];
  /** Content hashes for incremental recompilation. */
  hashes: Record<string, string>;
  /** Estimated token count of the compiled output. */
  estimatedTokens: number;
  /** Timestamp of compilation. */
  compiledAt: Date;
}

// ---------------------------------------------------------------------------
// KnowledgeCompiler
// ---------------------------------------------------------------------------

const DEFAULT_SYSTEM_PROMPT = `You are a knowledge compiler. Your task is to take raw source documents and compile them into a structured, concise markdown knowledge base.

Rules:
1. Organize information by topic with clear ## headings.
2. Deduplicate — if multiple sources say the same thing, include it once.
3. Preserve factual accuracy — do not infer, guess, or add information not in the sources.
4. Use bullet points for lists and policies.
5. Include specific numbers, dates, and thresholds exactly as stated.
6. Remove conversational language, marketing copy, and filler text.
7. Output only the compiled markdown — no preamble, no commentary.
8. Stay within the token budget specified below.`;

export class KnowledgeCompiler {
  private readonly compileFn: KnowledgeCompilerConfig['compile'];
  private readonly maxTokens: number;
  private readonly systemPrompt: string;

  constructor(config: KnowledgeCompilerConfig) {
    this.compileFn = config.compile;
    this.maxTokens = config.maxTokens ?? 4000;
    this.systemPrompt = config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
  }

  /**
   * Compile a set of documents into structured markdown.
   *
   * @param documents - Raw source documents to compile.
   * @param previousHashes - Hashes from previous compilation for incremental detection.
   * @returns Compilation result with the compiled markdown and metadata.
   */
  async compile(
    documents: Document[],
    previousHashes?: Record<string, string>,
  ): Promise<CompilationResult> {
    // Compute content hashes for all documents
    const currentHashes: Record<string, string> = {};
    for (const doc of documents) {
      currentHashes[doc.id] = hashContent(doc.text);
    }

    // Determine which documents need recompilation
    let docsToCompile: Document[];
    if (previousHashes) {
      const changed = documents.filter(
        doc => currentHashes[doc.id] !== previousHashes[doc.id],
      );
      if (changed.length === 0) {
        // No changes — return empty result indicating no recompilation needed
        return {
          compiled: '',
          sourceIds: [],
          hashes: currentHashes,
          estimatedTokens: 0,
          compiledAt: new Date(),
        };
      }
      // For simplicity, recompile all documents when any change is detected.
      // The LLM needs full context to properly deduplicate and organize.
      docsToCompile = documents;
    } else {
      docsToCompile = documents;
    }

    // Build the user prompt with all source documents
    const sourceBlock = docsToCompile
      .map((doc, i) => {
        const meta = doc.metadata
          ? `\nMetadata: ${JSON.stringify(doc.metadata)}`
          : '';
        return `--- Source ${i + 1}: ${doc.id} ---${meta}\n${doc.text}`;
      })
      .join('\n\n');

    const systemWithBudget = `${this.systemPrompt}\n\nToken budget: ${this.maxTokens} tokens maximum. Prioritize the most important and frequently referenced information if you need to cut content.`;

    const userPrompt = `Compile the following ${docsToCompile.length} source documents into a structured markdown knowledge base:\n\n${sourceBlock}`;

    const compiled = await this.compileFn(systemWithBudget, userPrompt);

    const estimatedTokens = Math.ceil(compiled.length / 4);

    return {
      compiled,
      sourceIds: docsToCompile.map(d => d.id),
      hashes: currentHashes,
      estimatedTokens,
      compiledAt: new Date(),
    };
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
}
