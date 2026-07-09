export interface ParsedSkill {
  name: string;
  description: string;
  body: string;
  license?: string;
  compatibility?: string;
  allowedTools?: string[];
  metadata?: Record<string, string>;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)([\s\S]*)$/;
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function parseSkillFrontmatter(content: string, ctx: { path: string }): ParsedSkill {
  const stripped = content.replace(/^\uFEFF/, '');
  const match = stripped.match(FRONTMATTER_RE);
  if (!match) {
    throw new Error(`[skills] Skill ${ctx.path} is missing YAML frontmatter.`);
  }

  const raw = parseFlatYaml(match[1] ?? '', ctx.path);
  const name = requireField(raw, 'name', ctx.path);
  const description = requireField(raw, 'description', ctx.path);

  validateName(name, ctx.path);
  validateDescription(description, ctx.path);

  const compatibility = optionalString(raw.compatibility);
  if (compatibility !== undefined && codePointLength(compatibility) > 500) {
    throw new Error(
      `[skills] Skill ${ctx.path} field "compatibility" exceeds 500 characters.`,
    );
  }

  let body = match[2] ?? '';
  if (body.startsWith('\n')) {
    body = body.slice(1);
  }

  const result: ParsedSkill = { name, description, body };
  const license = optionalString(raw.license);
  if (license !== undefined) result.license = license;
  if (compatibility !== undefined) result.compatibility = compatibility;

  const allowedTools = parseAllowedTools(raw['allowed-tools']);
  if (allowedTools !== undefined) result.allowedTools = allowedTools;

  const metadata = parseMetadata(raw.metadata);
  if (metadata !== undefined) result.metadata = metadata;

  return result;
}

function parseFlatYaml(yaml: string, path: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = yaml.split(/\r?\n/);
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === '') {
      i += 1;
      continue;
    }

    const keyMatch = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!keyMatch) {
      throw new Error(`[skills] Skill ${path} has invalid YAML frontmatter near line: ${line}`);
    }

    const key = keyMatch[1]!;
    const rest = (keyMatch[2] ?? '').trim();

    if (rest === '') {
      i += 1;
      if (i >= lines.length) break;
      const next = lines[i]!;
      if (next.match(/^\s+-\s+/)) {
        const items: string[] = [];
        while (i < lines.length) {
          const listLine = lines[i]!;
          const itemMatch = listLine.match(/^\s+-\s+(.*)$/);
          if (!itemMatch) break;
          items.push(parseScalar(itemMatch[1] ?? ''));
          i += 1;
        }
        result[key] = items;
        continue;
      }
      if (key === 'metadata') {
        const meta: Record<string, string> = {};
        while (i < lines.length) {
          const metaLine = lines[i]!;
          const metaMatch = metaLine.match(/^\s{2}([A-Za-z0-9_-]+):\s*(.*)$/);
          if (!metaMatch) break;
          meta[metaMatch[1]!] = parseScalar((metaMatch[2] ?? '').trim());
          i += 1;
        }
        result[key] = meta;
        continue;
      }
      result[key] = '';
      continue;
    }

    if (rest.startsWith('[') && rest.endsWith(']')) {
      const inner = rest.slice(1, -1).trim();
      result[key] =
        inner === ''
          ? []
          : inner.split(',').map((s) => parseScalar(s.trim()));
      i += 1;
      continue;
    }

    result[key] = parseScalar(rest);
    i += 1;
  }

  return result;
}

function parseScalar(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function requireField(raw: Record<string, unknown>, field: string, path: string): string {
  const value = raw[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`[skills] Skill ${path} must define frontmatter ${field} as a non-empty string.`);
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function validateName(name: string, path: string): void {
  if (name.length > 64) {
    throw new Error(`[skills] Skill ${path} field "name" must be at most 64 characters.`);
  }
  if (!NAME_PATTERN.test(name)) {
    throw new Error(
      `[skills] Skill ${path} field "name" "${name}" must match /^[a-z0-9]+(?:-[a-z0-9]+)*$/.`,
    );
  }
}

function validateDescription(description: string, path: string): void {
  if (codePointLength(description) > 1024) {
    throw new Error(`[skills] Skill ${path} field "description" exceeds 1024 characters.`);
  }
}

function codePointLength(value: string): number {
  return [...value].length;
}

function parseAllowedTools(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) {
    const tools = value.map((v) => String(v).trim()).filter(Boolean);
    return tools.length > 0 ? tools : undefined;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const tools = trimmed.includes(',')
      ? trimmed.split(',').map((s) => s.trim()).filter(Boolean)
      : trimmed.split(/\s+/).filter(Boolean);
    return tools.length > 0 ? tools : undefined;
  }
  return undefined;
}

function parseMetadata(value: unknown): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return undefined;
  const meta: Record<string, string> = {};
  for (const [k, v] of entries) {
    meta[k] = String(v);
  }
  return meta;
}