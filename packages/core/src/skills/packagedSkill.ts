const PACKAGED_SKILL_BRAND = Symbol.for('kuralle.packagedSkill');

export interface PackagedSkillFile {
  path: string;
  encoding: 'base64';
  kind: 'text' | 'binary';
  content: string;
}

export interface PackagedSkill {
  id: string;
  name: string;
  description: string;
  allowedTools?: readonly string[];
  files: Readonly<Record<string, PackagedSkillFile>>;
}

export function classifySkillFileKind(bytes: Uint8Array): 'text' | 'binary' {
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0) return 'binary';
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return 'text';
  } catch {
    return 'binary';
  }
}

export function brandPackagedSkill(skill: PackagedSkill): PackagedSkill {
  Object.defineProperty(skill, PACKAGED_SKILL_BRAND, {
    value: true,
    enumerable: false,
    configurable: false,
  });
  return skill;
}

export function isPackagedSkill(value: unknown): value is PackagedSkill {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<symbol, unknown>)[PACKAGED_SKILL_BRAND] === true
  );
}

export function isPackagedSkillArray(value: unknown): value is readonly PackagedSkill[] {
  return Array.isArray(value) && value.every(isPackagedSkill);
}
