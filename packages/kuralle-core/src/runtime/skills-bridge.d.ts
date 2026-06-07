declare module '@kuralle-agents/skills' {
  import type { AnyTool, PromptSection, SkillSource } from '../types/index.js';

  export interface WiredAgentSkills {
    tools: Record<string, AnyTool>;
    promptSections: PromptSection[];
  }

  export interface SkillWireAgent {
    skills?: SkillSource;
    tools?: Record<string, AnyTool>;
    globalTools?: Record<string, AnyTool>;
    flows?: Array<{ name: string }>;
  }

  export function wireAgentSkills(agent: SkillWireAgent): Promise<WiredAgentSkills | undefined>;
}
