const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface ValidateSkillOptions {
  path: string;
  directoryName?: string;
}

export function validateSkillName(name: string, options: ValidateSkillOptions): void {
  if (name.length > 64) {
    throw new Error(`[skills] Skill ${options.path} name must be at most 64 characters.`);
  }
  if (!NAME_PATTERN.test(name)) {
    throw new Error(
      `[skills] Skill ${options.path} frontmatter name "${name}" must contain only lowercase letters, numbers, and single internal hyphens.`,
    );
  }
  if (options.directoryName !== undefined && name !== options.directoryName) {
    throw new Error(
      `[skills] Skill ${options.path} declares frontmatter name "${name}", but Agent Skills requires it to match directory "${options.directoryName}".`,
    );
  }
}

export function validateSkillFields(
  skill: { name: string; description: string },
  options: ValidateSkillOptions,
): void {
  const name = skill.name?.trim();
  const description = skill.description?.trim();
  if (!name) {
    throw new Error(`[skills] Skill ${options.path} must define a non-empty name.`);
  }
  if (!description) {
    throw new Error(`[skills] Skill ${options.path} must define a non-empty description.`);
  }
  validateSkillName(name, options);
  if (description.length > 1024) {
    throw new Error(
      `[skills] Skill ${options.path} description exceeds the 1024-character Agent Skills limit.`,
    );
  }
}
