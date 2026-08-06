import { describe, expect, it } from 'bun:test';
import { parseSkillFrontmatter } from '../../src/skills/parseSkillFrontmatter.js';

/**
 * The four defects this suite pins, all present before the parser was moved onto a real
 * YAML implementation. Each case is legal per the Agent Skills specification, so a
 * spec-compliant third-party skill hits at least one of them.
 */
describe('SKILL.md frontmatter — spec-legal YAML the flat parser could not read', () => {
  it('reads a folded block scalar description', () => {
    const md = `---
name: folded
description: >
  Process a customer refund end-to-end.
  Use when a customer asks for a refund or disputes a charge.
---

Body.
`;
    const parsed = parseSkillFrontmatter(md, { path: '/skills/folded/SKILL.md' });
    expect(parsed.description).toBe(
      'Process a customer refund end-to-end. Use when a customer asks for a refund or disputes a charge.',
    );
  });

  it('reads a literal block scalar description', () => {
    const md = `---
name: literal
description: |
  Line one.
  Line two.
---

Body.
`;
    const parsed = parseSkillFrontmatter(md, { path: '/skills/literal/SKILL.md' });
    expect(parsed.description).toBe('Line one.\nLine two.');
  });

  it('reads a quoted scalar containing a colon', () => {
    const md = `---
name: colon
description: "Use when the caller says: refund me."
---

Body.
`;
    const parsed = parseSkillFrontmatter(md, { path: '/skills/colon/SKILL.md' });
    expect(parsed.description).toBe('Use when the caller says: refund me.');
  });

  it('keeps an unquoted numeric-looking metadata value a string', () => {
    // The Agent Skills reference implementation parses with strictyaml, where every
    // scalar is a string. A typed scalar here would fail string validation downstream.
    const md = `---
name: versioned
description: Has a version-shaped metadata value.
metadata:
  version: 1.0
---

Body.
`;
    const parsed = parseSkillFrontmatter(md, { path: '/skills/versioned/SKILL.md' });
    expect(parsed.metadata?.version).toBe('1.0');
  });

  it('rejects a name that disagrees with its directory, naming both', () => {
    const md = `---
name: bar
description: Declares a name that is not its directory.
---

Body.
`;
    expect(() =>
      parseSkillFrontmatter(md, { path: '/skills/foo/SKILL.md', directoryName: 'foo' }),
    ).toThrow(/bar[\s\S]*foo|foo[\s\S]*bar/);
  });

  it('accepts a name that agrees with its directory', () => {
    const md = `---
name: foo
description: Agrees with its directory.
---

Body.
`;
    expect(
      parseSkillFrontmatter(md, { path: '/skills/foo/SKILL.md', directoryName: 'foo' }).name,
    ).toBe('foo');
  });

  it('rejects frontmatter that is not a mapping', () => {
    const md = `---
- just
- a
- list
---

Body.
`;
    expect(() => parseSkillFrontmatter(md, { path: '/skills/list/SKILL.md' })).toThrow();
  });
});
