const encoder = new TextEncoder();

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function canonicalSkillContent(skill: {
  name: string;
  description: string;
  body: string;
  allowedTools?: readonly string[];
}): string {
  return JSON.stringify({
    name: skill.name,
    description: skill.description,
    body: skill.body,
    allowedTools: skill.allowedTools ?? [],
  });
}
