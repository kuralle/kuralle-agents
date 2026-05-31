import type { ToolSet } from '../tools/Tool.js';
import type {
  PromptSection,
  PromptTemplate,
  PromptBuilderConfig,
  BrandVoiceConfig,
  KnowledgeContext,
  SessionMemory,
  AgentDefinition,
  PolicyProfile,
} from './types.js';
import { LAYER_PRIORITIES } from './types.js';
import { getSecurityCore, SECURITY_REMINDER } from './security.js';
import { buildBrandVoiceSection } from './brandVoice.js';
import { composePersonaPrompt, type PersonaConfig } from '../persona/index.js';

export class PromptBuilder {
  private config: PromptBuilderConfig;

  /**
   * Accepts either:
   * - PromptBuilderConfig (new fluent API)
   * - PromptTemplate (backward compatible - treated as user template sections)
   */
  constructor(config: PromptBuilderConfig | PromptTemplate = {}) {
    // Handle backward compatibility: if it's a PromptTemplate, wrap it
    if ('sections' in config && 'id' in config) {
      this.config = { template: config as PromptTemplate };
    } else {
      this.config = config as PromptBuilderConfig;
    }
  }

  withTemplate(template: PromptTemplate): this {
    this.config.template = template;
    return this;
  }

  withAgentDefinition(definition: AgentDefinition): this {
    this.config.agentDefinition = definition;
    return this;
  }

  withBrandVoice(brandVoice: BrandVoiceConfig): this {
    this.config.brandVoice = brandVoice;
    return this;
  }

  withPersona(persona: PersonaConfig): this {
    return this.addPersona(persona);
  }

  addPersona(persona: PersonaConfig): this {
    this.config.persona = persona;
    return this;
  }

  withTools(tools: ToolSet): this {
    this.config.tools = tools;
    return this;
  }

  withSessionMemory(memory: SessionMemory): this {
    this.config.sessionMemory = memory;
    return this;
  }

  withKnowledgeContext(context: KnowledgeContext): this {
    this.config.knowledgeContext = context;
    return this;
  }

  withPolicyProfile(profile: PolicyProfile): this {
    this.config.policyProfile = profile;
    return this;
  }



  build(): string {
    const sections: PromptSection[] = [];

    // Layer 0: Security Core (IMMUTABLE - always first)
    sections.push({
      type: 'security_core',
      content: getSecurityCore(this.config.policyProfile ?? 'minimal'),
      priority: LAYER_PRIORITIES.SECURITY_CORE.min,
      immutable: true,
    });

    // Layer 1: Agent Definition
    if (this.config.agentDefinition) {
      sections.push(...this.buildAgentDefinitionSections());
    }

    if (this.config.persona) {
      sections.push(...this.buildPersonaSections());
    }

    // Layer 2: Brand Voice
    if (this.config.brandVoice) {
      sections.push(...this.buildBrandVoiceSections());
    }

    // User Template Sections (priority 10-99)
    if (this.config.template) {
      sections.push(...this.config.template.sections);
    }

    // Layer 3: Knowledge & Grounding
    if (this.config.knowledgeContext) {
      sections.push(...this.buildKnowledgeSections());
    }

    // Layer 4: Tools & Actions (auto)
    if (this.config.tools && Object.keys(this.config.tools).length > 0) {
      sections.push(...this.buildToolsSections());
    }

    // Layer 5: Session Memory (auto)
    if (this.config.sessionMemory) {
      sections.push(...this.buildSessionMemorySections());
    }

    // Layer 6: Security Reminder (IMMUTABLE - always last)
    sections.push({
      type: 'security_reminder',
      content: SECURITY_REMINDER,
      priority: LAYER_PRIORITIES.SECURITY_REMINDER,
      immutable: true,
    });

    // Sort by priority
    const sorted = sections.sort((a, b) =>
      (a.priority ?? 100) - (b.priority ?? 100)
    );

    return sorted.map(s => this.formatSection(s)).join('\n\n');
  }

  private buildAgentDefinitionSections(): PromptSection[] {
    const def = this.config.agentDefinition!;
    const sections: PromptSection[] = [];

    sections.push({
      type: 'identity',
      content: def.identity,
      priority: LAYER_PRIORITIES.IDENTITY,
    });

    sections.push({
      type: 'role',
      content: def.role,
      priority: LAYER_PRIORITIES.ROLE,
    });

    if (def.capabilities?.length) {
      sections.push({
        type: 'capabilities',
        content: `## Capabilities\n${def.capabilities.map(c => `- ${c}`).join('\n')}`,
        priority: 18,
      });
    }

    return sections;
  }

  private buildPersonaSections(): PromptSection[] {
    return [{
      type: 'persona',
      content: composePersonaPrompt(this.config.persona!),
      priority: LAYER_PRIORITIES.PERSONA,
    }];
  }

  private buildBrandVoiceSections(): PromptSection[] {
    const voice = this.config.brandVoice!;

    return [{
      type: 'brand_voice',
      content: buildBrandVoiceSection(voice),
      priority: LAYER_PRIORITIES.BRAND_VOICE,
    }];
  }

  private buildKnowledgeSections(): PromptSection[] {
    const knowledge = this.config.knowledgeContext!;
    const sections: PromptSection[] = [];

    // Retrieved context (RAG/CAG)
    if (knowledge.retrieved) {
      sections.push({
        type: 'knowledge',
        content: `## Knowledge Context\n\n${knowledge.retrieved}`,
        priority: LAYER_PRIORITIES.KNOWLEDGE,
      });
    }

    // Business rules
    if (knowledge.businessRules?.length) {
      sections.push({
        type: 'business_rules',
        content: `## Business Rules\n\n${knowledge.businessRules.map(r => `- ${r}`).join('\n')}`,
        priority: LAYER_PRIORITIES.BUSINESS_RULES,
      });
    }

    // Grounding rules (always included)
    sections.push({
      type: 'grounding_rules',
      content: `## Grounding Rules
- Only state facts that are supported by the knowledge context or tool results.
- If information is not available, say so clearly rather than guessing.
- When citing information, reference the source naturally.`,
      priority: LAYER_PRIORITIES.GROUNDING_RULES,
    });

    // Glossary
    if (knowledge.glossary?.length) {
      const glossaryContent = knowledge.glossary
        .map(t => `- **${t.name}**: ${t.description}${t.synonyms ? ` (also: ${t.synonyms.join(', ')})` : ''}`)
        .join('\n');
      sections.push({
        type: 'glossary',
        content: `## Glossary\n\n${glossaryContent}`,
        priority: LAYER_PRIORITIES.GLOSSARY,
      });
    }

    return sections;
  }

  private buildToolsSections(): PromptSection[] {
    const tools = this.config.tools!;
    const sections: PromptSection[] = [];

    const toolDescriptions = Object.entries(tools)
      .map(([name, tool]) => {
        const desc = 'description' in tool ? String(tool.description) : '';
        return `### ${name}\n${desc}`;
      })
      .join('\n\n');

    sections.push({
      type: 'tools',
      content: `## Available Tools\n\n${toolDescriptions}`,
      priority: LAYER_PRIORITIES.TOOLS,
    });

    sections.push({
      type: 'tool_contract',
      content: `## Tool Usage Rules
- Only use tools that are available.
- Report tool failures honestly.
- For critical operations, verify success before confirming to the user.`,
      priority: LAYER_PRIORITIES.TOOL_CONTRACT,
    });

    return sections;
  }

  private buildSessionMemorySections(): PromptSection[] {
    const memory = this.config.sessionMemory!;
    const sections: PromptSection[] = [];

    // Flow progress
    if (memory.flowProgress) {
      const collectedData = Object.keys(memory.flowProgress.collectedData).length > 0
        ? `\n**Collected Data:**\n${JSON.stringify(memory.flowProgress.collectedData, null, 2)}`
        : '';
      sections.push({
        type: 'flow_context',
        content: `## Current Flow State\n**Current Step:** ${memory.flowProgress.currentNode}${collectedData}`,
        priority: LAYER_PRIORITIES.FLOW_CONTEXT,
      });
    }

    // Conversation state
    if (memory.conversationState && Object.keys(memory.conversationState).length > 0) {
      sections.push({
        type: 'session_state',
        content: `## Session State\n\`\`\`json\n${JSON.stringify(memory.conversationState, null, 2)}\n\`\`\``,
        priority: LAYER_PRIORITIES.SESSION_STATE,
      });
    }

    // Working memory (injection queue)
    if (memory.workingMemory?.length) {
      const workingContent = memory.workingMemory
        .map(w => `### ${w.label}\n${w.content}`)
        .join('\n\n');
      sections.push({
        type: 'conversation_summary',
        content: `## Context\n\n${workingContent}`,
        priority: LAYER_PRIORITIES.CONVERSATION_SUMMARY,
      });
    }

    return sections;
  }

  private formatSection(section: PromptSection): string {
    const header = this.getHeader(section.type);
    // Custom and handoff sections include their own header in content
    if (section.type === 'custom' || section.type === 'handoff' || section.type === 'persona') {
      return section.content;
    }
    return `${header}\n\n${section.content}`;
  }

  private getHeader(type: PromptSection['type']): string {
    const headers: Record<string, string> = {
      // Security layers
      security_core: '# Security Core',
      security_reminder: '# Final Check',
      // Agent definition
      identity: '# Identity',
      role: '# Role',
      persona: '# Persona',
      capabilities: '# Capabilities',
      // Brand voice
      brand_voice: '# Brand Voice',
      tone: '# Tone',
      personality: '# Personality',
      // Knowledge & grounding
      knowledge: '# Knowledge Context',
      grounding_rules: '# Grounding Rules',
      business_rules: '# Business Rules',
      // Tools
      tools: '# Tools',
      tool_contract: '# Tool Usage',
      // Session memory
      session_state: '# Session State',
      flow_context: '# Flow Context',
      conversation_summary: '# Context',
      // Legacy
      character_normalization: '# Character Normalization',
      voice_rules: '# Voice Output Rules',
      system_reminder: '# System Reminder',
      error_handling: '# Error Handling',
      brief_speech: '# Response Style',
      handoff: '',
      custom: '',
    };
    return headers[type] || '# Custom';
  }
}

// Fluent builder factory
export function createPrompt(): PromptBuilder {
  return new PromptBuilder();
}
