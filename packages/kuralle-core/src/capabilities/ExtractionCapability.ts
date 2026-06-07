import type { ZodTypeAny } from 'zod';
import type { Capability, ToolDeclaration, PromptSection, CapabilityAction } from './index.js';
import { mergeExtractionData, computeMissingFields, toExtractionSubmissionSchema } from '../flows/extraction.js';
import type {
  ExtractionPassParams,
  ExtractionPassResult,
  ExtractionStrategy,
} from '../extraction/ExtractionStrategy.js';

// ─── Config ──────────────────────────────────────────────────────────────────

export interface ExtractionCapabilityConfig {
  schema: ZodTypeAny;
  /** Fields that must be present to consider extraction complete. */
  requiredFields?: string[];
}

// ─── ExtractionCapability ────────────────────────────────────────────────────

/**
 * Agent-level extraction: collects structured data across turns using a
 * single `submit_extracted_data` tool. Distinct from flow-node extraction in
 * per-node extraction — this is for standalone agents, not flow nodes.
 */
export class ExtractionCapability implements Capability, ExtractionStrategy {
  readonly name = 'extraction-capability';

  private schema: ZodTypeAny;
  private requiredFields: string[];
  private collectedData: Record<string, unknown> = {};

  constructor(config: ExtractionCapabilityConfig) {
    this.schema = config.schema;
    this.requiredFields = config.requiredFields ?? [];
  }

  getTools(): ToolDeclaration[] {
    const missing = this.getMissingFields();

    return [
      {
        name: 'submit_extracted_data',
        description: [
          'Submit information extracted from the conversation.',
          missing.length > 0
            ? `Still needed: ${missing.join(', ')}.`
            : 'All required fields collected.',
          'Only submit values explicitly provided by the user.',
          'Omit fields or use null when the value is still unknown.',
          'Call this tool every time you learn new field values.',
        ].join(' '),
        parameters: toExtractionSubmissionSchema(this.schema),
        execute: async (args: unknown) => args,
      },
    ];
  }

  getPromptSections(): PromptSection[] {
    const missing = this.getMissingFields();
    if (missing.length === 0) return [];

    return [
      {
        role: 'extraction',
        content: `You still need to collect: ${missing.join(', ')}. Ask for these naturally.`,
      },
    ];
  }

  processToolResult(toolName: string, args: unknown, result: unknown): CapabilityAction | null {
    if (toolName !== 'submit_extracted_data') return null;

    this.collectedData = mergeExtractionData(
      this.collectedData,
      args as Record<string, unknown>,
    );

    const missing = this.getMissingFields();
    if (missing.length === 0) {
      return { type: 'extraction-complete', data: this.collectedData };
    }
    return { type: 'continue' };
  }

  /** Read the data collected so far. */
  get data(): Record<string, unknown> {
    return this.collectedData;
  }

  /**
   * ExtractionStrategy impl — merges `params.currentData` into capability
   * state and returns the resulting snapshot. Does not run an LLM call;
   * LLM-driven extraction for this capability happens through the
   * `submit_extracted_data` tool and `processToolResult`.
   */
  async runExtractionPass(params: ExtractionPassParams): Promise<ExtractionPassResult> {
    if (params.currentData && Object.keys(params.currentData).length > 0) {
      this.collectedData = mergeExtractionData(this.collectedData, params.currentData);
    }
    const missing = this.getMissingFields();
    return {
      extractedFields: params.currentData ?? {},
      mergedData: { ...this.collectedData },
      missingFields: missing,
      complete: missing.length === 0,
    };
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  private getMissingFields(): string[] {
    if (this.requiredFields.length > 0) {
      return computeMissingFields(this.collectedData, this.requiredFields);
    }
    // Fall back to Zod schema parse to infer missing fields
    const parsed = this.schema.safeParse(this.collectedData);
    if (parsed.success) return [];
    return [...new Set(
      (parsed.error.issues ?? [])
        .map((issue) => issue.path.join('.'))
        .filter(Boolean),
    )];
  }
}
