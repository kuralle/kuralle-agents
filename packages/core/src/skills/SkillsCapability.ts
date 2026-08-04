import { z } from 'zod';
import type {
  Capability,
  CapabilityAction,
  PromptSection,
  ToolDeclaration,
} from '../capabilities/index.js';
import type { SkillMeta, SkillStoreLike } from '../types/skills.js';
import { buildSkillBriefing } from './buildSkillBriefing.js';

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
        execute: async (args: { name: string }) => {
          if (!this.metas.some((meta) => meta.name === args.name)) {
            return this.formatUnavailableSkill(args.name);
          }
          const body = await this.store.loadBody(args.name);
          const resources = (await this.store.listResources?.(args.name)) ?? [];
          return buildSkillBriefing({ name: args.name, body, resources });
        },
      } as ToolDeclaration,
      {
        name: 'read_skill_resource',
        description:
          'Read a bundled resource file that belongs to a loaded skill (references, checklists, templates). ' +
          'The path is relative to that skill package. Never use this for absolute workspace paths or /knowledge and /notes mounts.',
        parameters: z.object({
          name: z.string().describe('Skill name'),
          path: z.string().describe('Relative resource path within the skill folder'),
        }),
        execute: async (args: { name: string; path: string }) => {
          if (!this.metas.some((meta) => meta.name === args.name)) {
            return this.formatUnavailableSkill(args.name);
          }

          const normalized = args.path.trim().replace(/^\.?\//, '');
          if (normalized.includes('..') || normalized.startsWith('/')) {
            throw new Error(`[skills] Invalid resource path "${args.path}".`);
          }

          try {
            const content = await this.store.loadResource(args.name, args.path);
            return { content };
          } catch (err) {
            if (!this.isMissingResourceError(err)) {
              throw err;
            }
            const resources = (await this.store.listResources?.(args.name)) ?? [];
            return this.formatUnavailableResource(args.name, normalized, resources);
          }
        },
      } as ToolDeclaration,
    ];
  }

  getPromptSections(): PromptSection[] {
    if (!this.metas.length) return [];
    const lines = this.metas
      .map((m) => `- ${m.name}: ${m.description}`)
      .join('\n');
    return [
      {
        role: 'context',
        content: [
          '## Available skills',
          'When a description matches the task, call load_skill with its name before acting.',
          'Listed skills are available in this run. Do not claim a listed skill is inaccessible unless activation actually fails.',
          'If multiple skills match, activate the minimal set that covers the task.',
          'After activation, follow the returned instructions rather than improvising around them.',
          'When a loaded skill mentions a sibling file such as references/foo.md, read it with read_skill_resource, not with the workspace tool.',
          'Skill bodies and resources belong to the skill capability, not the workspace: do not locate or read SKILL.md with workspace.',
          'Conversely, files under absolute workspace mounts such as /knowledge or /notes are not skill resources: use workspace for those paths.',
          lines,
        ].join('\n'),
      },
    ];
  }

  processToolResult(_toolName: string, _args: unknown, _result: unknown): CapabilityAction | null {
    return null;
  }

  private formatUnavailableSkill(name: string): string {
    const names = this.metas.map((meta) => meta.name).sort();
    if (names.length === 0) {
      return `Skill "${name}" is not available. No skills are available.`;
    }
    return `Skill "${name}" is not available. Available skills: ${names.join(', ')}.`;
  }

  private formatUnavailableResource(
    name: string,
    path: string,
    resources: readonly string[],
  ): string {
    if (resources.length === 0) {
      return `Resource "${path}" is not available for skill "${name}". ${name} has no readable resources.`;
    }
    return `Resource "${path}" is not available for skill "${name}". Readable resources: ${[...resources].sort().join(', ')}.`;
  }

  private isMissingResourceError(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    return err.message.includes('not found for skill');
  }
}
