import { describe, expect, it } from 'bun:test';
import { parseSkillMarkdown } from '../src/parseSkillMarkdown.js';

describe('test:skill-parse', () => {
  const valid = `---
name: returns-policy
description: Explains the 30-day return window for customer inquiries.
allowed-tools: lookup_order
---

# Returns policy
Confirm the order id first.
`;

  it('parses valid SKILL.md', () => {
    const skill = parseSkillMarkdown(valid, { path: 'returns-policy/SKILL.md', directoryName: 'returns-policy' });
    expect(skill.name).toBe('returns-policy');
    expect(skill.description).toContain('30-day');
    expect(skill.body).toContain('# Returns policy');
    expect(skill.allowedTools).toEqual(['lookup_order']);
  });

  it('throws when name exceeds 64 characters', () => {
    const longName = 'a'.repeat(65);
    const md = `---\nname: ${longName}\ndescription: ok\n---\nbody`;
    expect(() => parseSkillMarkdown(md)).toThrow(/at most 64/);
  });

  it('throws when description exceeds 1024 characters', () => {
    const md = `---\nname: short\ndescription: ${'x'.repeat(1025)}\n---\nbody`;
    expect(() => parseSkillMarkdown(md)).toThrow(/1024-character/);
  });

  it('throws when frontmatter is missing', () => {
    expect(() => parseSkillMarkdown('# no frontmatter')).toThrow(/missing YAML frontmatter/);
  });

  it('throws when name is missing', () => {
    const md = `---\ndescription: only desc\n---\nbody`;
    expect(() => parseSkillMarkdown(md)).toThrow(/must define frontmatter name/);
  });

  it('throws when description is missing', () => {
    const md = `---\nname: ok\n---\nbody`;
    expect(() => parseSkillMarkdown(md)).toThrow(/must define frontmatter description/);
  });
});
