import { describe, expect, it } from 'bun:test';
import {
  brandPackagedSkill,
  defineSkill,
  packagedSkillStore,
  prepareSkillStore,
} from '../../src/skills/index.js';
import { classifySkillFileKind } from '../../src/skills/packagedSkill.js';

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

function buildPackagedSkill(name: string, description: string, body: string, resources: Record<string, Uint8Array> = {}) {
  const skillMd = `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`;
  const files: Record<string, { path: string; encoding: 'base64'; kind: 'text' | 'binary'; content: string }> = Object.create(null);
  files['SKILL.md'] = {
    path: 'SKILL.md',
    encoding: 'base64',
    kind: 'text',
    content: bytesToBase64(new TextEncoder().encode(skillMd)),
  };
  for (const [path, bytes] of Object.entries(resources)) {
    files[path] = {
      path,
      encoding: 'base64',
      kind: classifySkillFileKind(bytes),
      content: bytesToBase64(bytes),
    };
  }
  return brandPackagedSkill({
    id: `skill:${name}:placeholder`,
    name,
    description,
    files,
  });
}

describe('packagedSkillStore', () => {
  const binaryBytes = new Uint8Array([0xff, 0xfe, 0xfd, 0x00, 0x01, 0x02]);
  const packaged = buildPackagedSkill('demo', 'Demo skill.', 'Demo body.', {
    'data.bin': binaryBytes,
    'references/note.md': new TextEncoder().encode('# Note'),
  });

  const store = packagedSkillStore([packaged]);

  it('loadBody returns the body with frontmatter stripped', async () => {
    expect(await store.loadBody('demo')).toBe('Demo body.');
  });

  it('loadResource on a binary fixture returns a byte-identical Uint8Array', async () => {
    const resource = await store.loadResource('demo', 'data.bin');
    expect(resource).toBeInstanceOf(Uint8Array);
    expect(resource).toEqual(binaryBytes);
  });

  it('rejects traversal paths', async () => {
    await expect(store.loadResource('demo', '..')).rejects.toThrow(/Invalid resource path/);
    await expect(store.loadResource('demo', '/../secret')).rejects.toThrow(/Invalid resource path/);
    await expect(store.loadResource('demo', '/data.bin')).rejects.toThrow(/Invalid resource path/);
    await expect(store.loadResource('demo', 'a\\b')).rejects.toThrow(/Invalid resource path/);
    await expect(store.loadResource('demo', '%2e%2e')).rejects.toThrow(/Invalid resource path/);
    await expect(store.loadResource('demo', 'C:\\secret')).rejects.toThrow(/Invalid resource path/);
  });

  it('throws a message containing not found for skill on a missing resource', async () => {
    await expect(store.loadResource('demo', 'missing.md')).rejects.toThrow(/not found for skill/);
  });

  it('lists resources excluding SKILL.md', async () => {
    expect(await store.listResources('demo')).toEqual(['data.bin', 'references/note.md']);
  });

  it('loadResource treats SKILL.md as a miss, not a resource', async () => {
    await expect(store.loadResource('demo', 'SKILL.md')).rejects.toThrow(/not found for skill/);
  });
});

describe('prepareSkillStore packaged layering', () => {
  it('resolves later inline defineSkill over a packaged array with the same name', async () => {
    const packaged = buildPackagedSkill('layered', 'Packaged.', 'Packaged body.');
    const inline = defineSkill({
      name: 'layered',
      description: 'Inline.',
      instructions: 'Inline body.',
    });

    const { skills } = await prepareSkillStore([[packaged], inline]);
    expect(skills).toHaveLength(1);
    expect(skills[0]?.body).toBe('Inline body.');
  });

  it('loads a JSON round-tripped packaged skill array through prepareSkillStore', async () => {
    const packaged = buildPackagedSkill('json-roundtrip', 'JSON.', 'Round-tripped body.');
    const roundTripped = JSON.parse(JSON.stringify([packaged])) as typeof packaged[];
    const { skills } = await prepareSkillStore([roundTripped]);
    expect(skills).toHaveLength(1);
    expect(skills[0]?.name).toBe('json-roundtrip');
    expect(skills[0]?.body).toBe('Round-tripped body.');
  });
});

describe('prepareSkillStore authoring errors', () => {
  it('throws when a branded packaged skill is mixed into a bare inline entry list', async () => {
    const packaged = buildPackagedSkill('pkg', 'Pkg.', 'Pkg body.');
    const inline = defineSkill({ name: 'inline', description: 'Inline.', instructions: 'Inline body.' });
    await expect(prepareSkillStore([packaged, inline])).rejects.toThrow(/must be passed as an array entry/);
  });

  it('throws when an inline skill object is missing a body', async () => {
    await expect(
      prepareSkillStore([{ name: 'broken', description: 'Broken.' } as never]),
    ).rejects.toThrow(/missing a body/);
  });

  it('throws when an unbranded packaged-shaped object is missing a body', async () => {
    await expect(
      prepareSkillStore([
        {
          id: 'skill:orphan:abc',
          name: 'orphan',
          description: 'Orphan.',
          files: {},
        } as never,
      ]),
    ).rejects.toThrow(/missing a body/);
  });
});
