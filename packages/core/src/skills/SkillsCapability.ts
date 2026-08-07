import { z } from 'zod';
import type {
  Capability,
  CapabilityAction,
  CapabilityPromptSection,
  ToolDeclaration,
} from '../capabilities/index.js';
import { assertSafeSkillResourcePath } from './assertSafeSkillResourcePath.js';
import { buildSkillBriefing } from './buildSkillBriefing.js';
import { LiveSkillCatalog } from './liveSkillCatalog.js';
import { renderSkillCatalogPrompt } from './skillCatalog.js';

export class SkillsCapability implements Capability {
  constructor(private readonly catalog: LiveSkillCatalog) {}

  getTools(): ToolDeclaration[] {
    return [
      {
        name: 'load_skill',
        description: "Load a skill's full instructions by name when the task matches its description.",
        parameters: z.object({
          // Deliberately a plain `z.string()`, NOT a literal union of the known skill names.
          // The serialized tools block is its own cacheable prefix segment for providers, and
          // a literal union is derived from the catalog — so every add/remove mid-session would
          // rewrite that block and discard the prompt cache for the entire conversation. The
          // roster changes are announced in the transcript instead (see `skillCatalog.ts`), and
          // availability is enforced at the tool boundary (the `has` check below), not by the
          // schema. Tightening this to a union is the "obvious fix" that regains correctness at
          // the cost of every cache hit; do not do it without solving the cache invalidation.
          name: z.string().describe('Skill name from the available skills list'),
        }),
        execute: async (args: { name: string }) => {
          if (!this.catalog.has(args.name)) {
            return this.formatUnavailableSkill(args.name);
          }
          const body = await this.catalog.loadBody(args.name);
          const resources = await this.catalog.listResources(args.name);
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
          if (!this.catalog.has(args.name)) {
            return this.formatUnavailableSkill(args.name);
          }

          const normalized = assertSafeSkillResourcePath(args.path);

          try {
            const content = await this.catalog.loadResource(args.name, args.path);
            return { content };
          } catch (err) {
            if (!this.isMissingResourceError(err)) {
              throw err;
            }
            const resources = await this.catalog.listResources(args.name);
            return this.formatUnavailableResource(args.name, normalized, resources);
          }
        },
      } as ToolDeclaration,
    ];
  }

  getPromptSections(): CapabilityPromptSection[] {
    // The prompt lists the FROZEN baseline only — what was wired at startup. Skills added
    // or withdrawn mid-session never appear here (that would rewrite the cached prompt);
    // they are announced in the transcript. See `skillCatalog.ts`.
    const prompt = renderSkillCatalogPrompt(
      this.catalog.frozenBaseline().map((m) => ({ name: m.name, description: m.description })),
    );
    if (!prompt) return [];
    return [{ role: 'context', content: prompt }];
  }

  getCatalog(): LiveSkillCatalog {
    return this.catalog;
  }

  processToolResult(_toolName: string, _args: unknown, _result: unknown): CapabilityAction | null {
    return null;
  }

  private formatUnavailableSkill(name: string): string {
    const names = this.catalog.entries().map((entry) => entry.name).sort();
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
