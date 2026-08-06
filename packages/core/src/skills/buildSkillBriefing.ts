export function buildSkillBriefing(input: {
  name: string;
  body: string;
  resources: readonly string[];
}): string {
  const lines = [
    `Run the skill named "${input.name}".`,
    '',
    '<skill_instructions>',
    input.body,
    '</skill_instructions>',
  ];

  if (input.resources.length > 0) {
    lines.push(
      '',
      'Supporting skill resources are available but are not loaded into context unless needed:',
      '<skill_resources>',
      ...input.resources.map(
        (path) =>
          `- ${path} -> read_skill_resource { name: "${input.name}", path: "${path}" }`,
      ),
      '</skill_resources>',
    );
  }

  return lines.join('\n');
}
