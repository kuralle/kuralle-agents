import type { Skill } from './types.js';
import { validateSkillFields } from './validateSkill.js';

export interface ParseSkillMarkdownOptions {
  path?: string;
  directoryName?: string;
}

const FRONTMATTER_RE = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)([\s\S]*)$/;

export function parseSkillMarkdown(md: string, opts: ParseSkillMarkdownOptions = {}): Skill {
  const path = opts.path ?? 'SKILL.md';
  const match = md.match(FRONTMATTER_RE);
  if (!match) {
    throw new Error(
      `[skills] Skill ${path} is missing YAML frontmatter. Start SKILL.md with "---", include "name" and "description", then close the block with "---".`,
    );
  }

  const raw = parseFrontmatterMapping(match[1] ?? '', path);
  const name = requireString(raw.name, path, 'name');
  const description = requireString(raw.description, path, 'description');
  validateSkillFields({ name, description }, { path, directoryName: opts.directoryName });

  return {
    name,
    description,
    body: (match[2] ?? '').trim(),
    allowedTools: parseAllowedTools(raw['allowed-tools'], path),
  };
}

function parseFrontmatterMapping(yaml: string, path: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = yaml.split(/\r?\n/);
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    const keyMatch = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!keyMatch) {
      if (line.trim() === '') {
        i += 1;
        continue;
      }
      throw new Error(`[skills] Skill ${path} has invalid YAML frontmatter near line: ${line}`);
    }

    const key = keyMatch[1]!;
    const rest = keyMatch[2] ?? '';

    if (rest === '|' || rest === '>') {
      const block: string[] = [];
      i += 1;
      while (i < lines.length && (lines[i]!.startsWith('  ') || lines[i]!.startsWith('\t'))) {
        block.push(lines[i]!.replace(/^\s{2}/, ''));
        i += 1;
      }
      result[key] = block.join('\n').trimEnd();
      continue;
    }

    if ((rest.startsWith('"') && rest.endsWith('"')) || (rest.startsWith("'") && rest.endsWith("'"))) {
      result[key] = rest.slice(1, -1);
      i += 1;
      continue;
    }

    result[key] = rest.trim();
    i += 1;
  }

  if (Object.keys(result).length === 0) {
    throw new Error(`[skills] Skill ${path} frontmatter must be a YAML mapping.`);
  }

  return result;
}

function requireString(value: unknown, path: string, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`[skills] Skill ${path} must define frontmatter ${field} as a non-empty string.`);
  }
  return value.trim();
}

function parseAllowedTools(value: unknown, path: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`[skills] Skill ${path} frontmatter allowed-tools must be a string when provided.`);
  }
  const tools = value.trim().split(/\s+/).filter(Boolean);
  return tools.length > 0 ? tools : undefined;
}
