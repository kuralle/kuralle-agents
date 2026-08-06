import { defineTool } from '@kuralle-agents/core';
import { z } from 'zod';

export interface LintToolsDeps {
  /** The closed set of surfaces this agent may lint against, fixed at construction. */
  surfaces: readonly [string, ...string[]];
}

const BANNED_WORDS_PATH = 'references/banned-words.json';

/**
 * Deterministically checks a draft against the active surface skill's banned-words resource.
 *
 * The surface enum is fixed at construction, not caller-supplied: the model picks a surface
 * only from the closed set the factory was built with, so the resolved skill id
 * (`${surface}-style`) and resource path can never be influenced by the caller — no model
 * input is ever concatenated into a skill id or file path.
 *
 * Diverges from the ported template on purpose: the template treated any failure to resolve,
 * read, parse, or validate the banned-words list as "no banned words", which means a checker
 * whose list was renamed or corrupted silently reports clean forever. Here, any such failure
 * is a thrown tool error naming the skill and path — a checker that cannot check must say so.
 */
export function createLintTools(deps: LintToolsDeps) {
  const surface = z.enum(deps.surfaces);

  const lint_against_style = defineTool({
    name: 'lint_against_style',
    description: 'Check a draft against the active surface skill’s banned-words list.',
    input: z.object({ surface, text: z.string().min(1).max(200_000) }),
    execute: async ({ surface: selected, text }, ctx) => {
      if (!ctx) {
        throw new Error('lint_against_style requires a run context to resolve the surface skill.');
      }
      const skillName = `${selected}-style`;
      let raw: string;
      try {
        raw = await ctx.getSkill(skillName).file(BANNED_WORDS_PATH).text();
      } catch (error) {
        throw new Error(
          `lint_against_style: could not read ${BANNED_WORDS_PATH} for skill "${skillName}": ${errorMessage(error)}`,
        );
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error(
          `lint_against_style: ${BANNED_WORDS_PATH} for skill "${skillName}" is not valid JSON.`,
        );
      }
      if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
        throw new Error(
          `lint_against_style: ${BANNED_WORDS_PATH} for skill "${skillName}" must be a JSON array of strings.`,
        );
      }

      const banned = [...new Set(parsed.map((term) => term.trim()).filter(Boolean))];
      const violations = banned.filter((term) => literalMatcher(term).test(text));
      return { violations };
    },
  });

  return { lint_against_style };
}

function literalMatcher(term: string): RegExp {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const left = /^\w/.test(term) ? '\\b' : '';
  const right = /\w$/.test(term) ? '\\b' : '';
  return new RegExp(`${left}${escaped}${right}`, 'i');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
