import type { PromptTemplate } from '../prompts/types.js';
import type { AgentPrompt } from '../prompts/AgentPrompt.js';

/**
 * Shared agent definition — the minimal shape every engine needs.
 * Runtime extends this interface.
 *
 * Define agents once against this interface, then spread into
 * engine-specific configs to add model, voice, processors, etc.
 */
export interface AgentDefinition {
  id: string;
  name: string;
  description?: string;
  /** Agent prompt — a plain string, PromptTemplate, or structured AgentPrompt. */
  prompt?: string | PromptTemplate | AgentPrompt;
  tools?: Record<string, unknown>;
}
