import { z } from 'zod';
import type {
  Capability,
  CapabilityAction,
  PromptSection,
  ToolDeclaration,
} from '../capabilities/index.js';
import type { SkillMeta, SkillStoreLike } from '../types/skills.js';

export class SkillsCapability implements Capability {
  constructor(
    private readonly store: SkillStoreLike,
    private readonly metas: SkillMeta[],
  ) {}

  getTools(): ToolDeclaration[] {
    return [
      {
        name: 'load_skill',
        description: "Load a skill's full instructions by name when the task matches its description.",
        parameters: z.object({
          name: z.string().describe('Skill name from the available skills list'),
        }),
        execute: async (args: { name: string }) => ({
          body: await this.store.loadBody(args.name),
        }),
      } as ToolDeclaration,
      {
        name: 'read_skill_resource',
        description: 'Read a bundled resource file from a skill (reference docs, checklists, etc.).',
        parameters: z.object({
          name: z.string().describe('Skill name'),
          path: z.string().describe('Relative resource path within the skill folder'),
        }),
        execute: async (args: { name: string; path: string }) => ({
          content: await this.store.loadResource(args.name, args.path),
        }),
      } as ToolDeclaration,
    ];
  }

  getPromptSections(): PromptSection[] {
    if (!this.metas.length) return [];
    // Include the path for file-backed skills so the model can read SKILL.md directly
    // instead of guessing a location — the difference between dispatching a skill by
    // reference and merely naming it.
    const lines = this.metas
      .map((m) => `- ${m.name}: ${m.description}${m.path ? ` (path: ${m.path})` : ''}`)
      .join('\n');
    return [
      {
        role: 'context',
        content: [
          '## Available skills',
          'Load a skill with load_skill when its description matches the task:',
          lines,
        ].join('\n'),
      },
    ];
  }

  processToolResult(_toolName: string, _args: unknown, _result: unknown): CapabilityAction | null {
    return null;
  }
}
