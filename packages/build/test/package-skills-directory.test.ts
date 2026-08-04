import { describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { packageSkillsDirectory } from '../src/packageSkillsDirectory.js';
import { isPackagedSkill } from '@kuralle-agents/core';

const FIXTURES = join(import.meta.dir, 'fixtures', 'skills-packaging');
const ENV_FIXTURES = join(import.meta.dir, 'fixtures', 'skills-packaging-with-env');

describe('packageSkillsDirectory', () => {
  it('packages a fixture directory twice with byte-identical ids', async () => {
    const first = await packageSkillsDirectory(FIXTURES);
    const second = await packageSkillsDirectory(FIXTURES);
    const alphaFirst = first.find((skill) => skill.name === 'alpha');
    const alphaSecond = second.find((skill) => skill.name === 'alpha');
    expect(alphaFirst?.id).toBe(alphaSecond?.id);
    expect(isPackagedSkill(alphaFirst)).toBe(true);
  });

  it('assigns different ids when file contents differ', async () => {
    const skills = await packageSkillsDirectory(FIXTURES);
    const alpha = skills.find((skill) => skill.name === 'alpha');
    const beta = skills.find((skill) => skill.name === 'beta');
    expect(alpha?.id).toBeDefined();
    expect(beta?.id).toBeDefined();
    expect(alpha?.id).not.toBe(beta?.id);
  });

  it('assigns different ids when skill names match but file content differs', async () => {
    const skillMd = '---\nname: probe\ndescription: Probe.\n---\n\nBody.\n';
    const rootA = await mkdtemp(join(tmpdir(), 'skills-same-name-a-'));
    const rootB = await mkdtemp(join(tmpdir(), 'skills-same-name-b-'));
    await mkdir(join(rootA, 'probe'), { recursive: true });
    await mkdir(join(rootB, 'probe'), { recursive: true });
    await writeFile(join(rootA, 'probe', 'SKILL.md'), skillMd);
    await writeFile(join(rootB, 'probe', 'SKILL.md'), skillMd);
    await writeFile(join(rootA, 'probe', 'data.txt'), 'content-a');
    await writeFile(join(rootB, 'probe', 'data.txt'), 'content-b');

    const idA = (await packageSkillsDirectory(rootA))[0]?.id;
    const idB = (await packageSkillsDirectory(rootB))[0]?.id;
    expect(idA).toBeDefined();
    expect(idB).toBeDefined();
    expect(idA).not.toBe(idB);
  });

  it('throws when a skill directory contains .env, naming the file', async () => {
    await expect(packageSkillsDirectory(ENV_FIXTURES)).rejects.toThrow(/\.env/);
  });

  // macOS and Windows are case-insensitive by default, so `.ENV` and `.env` are the
  // same file on the machines most authors use. Matching case-sensitively would refuse
  // one spelling and package the other.
  it.each([
    ['.ENV', 'K=v'],
    ['.Env.production', 'K=v'],
    ['.DEV.VARS', 'K=v'],
    ['.NETRC', 'machine example.com'],
    ['Credentials.json', '{}'],
    ['SECRETS.yaml', 'a: b'],
    ['private.PEM', '-----BEGIN-----'],
  ])('refuses %s regardless of case', async (filename, contents) => {
    const root = await mkdtemp(join(tmpdir(), 'skills-case-'));
    await mkdir(join(root, 'cased'), { recursive: true });
    await writeFile(
      join(root, 'cased', 'SKILL.md'),
      '---\nname: cased\ndescription: Case probe.\n---\n\nBody.\n',
    );
    await writeFile(join(root, 'cased', filename), contents);

    await expect(packageSkillsDirectory(root)).rejects.toThrow(/sensitive file/i);
  });

  it('throws when a skill directory contains a symlink', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skills-symlink-'));
    await mkdir(join(root, 'bad'), { recursive: true });
    await writeFile(
      join(root, 'bad', 'SKILL.md'),
      '---\nname: bad\ndescription: Bad skill.\n---\n\nBody.\n',
    );
    await writeFile(join(root, 'bad', 'target.txt'), 'target');
    await symlink(join(root, 'bad', 'target.txt'), join(root, 'bad', 'link.txt'));

    await expect(packageSkillsDirectory(root)).rejects.toThrow(/symbolic link/i);
  });

  it('throws when the skills root contains a symlinked skill directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skills-root-symlink-'));
    const realDir = join(root, 'real-skill');
    await mkdir(realDir, { recursive: true });
    await writeFile(
      join(realDir, 'SKILL.md'),
      '---\nname: real-skill\ndescription: Real skill.\n---\n\nBody.\n',
    );
    await symlink(realDir, join(root, 'linked-skill'));

    await expect(packageSkillsDirectory(root)).rejects.toThrow(/symbolic link/i);
  });

  it('refuses .dev.varsbackup as a sensitive file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skills-devvars-backup-'));
    await mkdir(join(root, 'leaky'), { recursive: true });
    await writeFile(
      join(root, 'leaky', 'SKILL.md'),
      '---\nname: leaky\ndescription: Leaky.\n---\n\nBody.\n',
    );
    await writeFile(join(root, 'leaky', '.dev.varsbackup'), 'SECRET=v');

    await expect(packageSkillsDirectory(root)).rejects.toThrow(/sensitive file/i);
  });

  it('allows .envbackup — only .env and .env.* are refused, not .envbackup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skills-env-backup-'));
    await mkdir(join(root, 'ok'), { recursive: true });
    await writeFile(
      join(root, 'ok', 'SKILL.md'),
      '---\nname: ok\ndescription: Ok.\n---\n\nBody.\n',
    );
    await writeFile(join(root, 'ok', '.envbackup'), 'K=v');

    const skills = await packageSkillsDirectory(root);
    expect(skills.find((skill) => skill.name === 'ok')).toBeDefined();
  });

  it('packages __proto__ and constructor filenames without id collision', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skills-proto-'));
    await mkdir(join(root, 's1'), { recursive: true });
    await writeFile(
      join(root, 's1', 'SKILL.md'),
      '---\nname: s1\ndescription: S1.\n---\n\nBody.\n',
    );
    const baseOnly = await packageSkillsDirectory(root);
    expect(Object.keys(baseOnly[0]!.files)).toEqual(['SKILL.md']);

    await writeFile(join(root, 's1', '__proto__'), 'proto-bytes');
    await writeFile(join(root, 's1', 'constructor'), 'ctor-bytes');
    const withSpecial = await packageSkillsDirectory(root);
    const skill = withSpecial.find((s) => s.name === 's1');
    expect(skill).toBeDefined();
    expect(Object.keys(skill!.files).sort()).toEqual(['SKILL.md', '__proto__', 'constructor']);
    expect(skill!.id).not.toBe(baseOnly[0]!.id);
  });

  it('packages successfully while excluding node_modules', async () => {
    const skills = await packageSkillsDirectory(FIXTURES);
    const withModules = skills.find((skill) => skill.name === 'with-node-modules');
    expect(withModules).toBeDefined();
    expect(Object.keys(withModules!.files)).toEqual(['SKILL.md']);
  });

  it('classifies binary resources and preserves bytes', async () => {
    const skills = await packageSkillsDirectory(FIXTURES);
    const withBinary = skills.find((skill) => skill.name === 'with-binary');
    expect(withBinary).toBeDefined();
    const file = withBinary!.files['data.bin'];
    expect(file.kind).toBe('binary');
    const expected = await readFile(join(FIXTURES, 'with-binary', 'data.bin'));
    const actual = Buffer.from(file.content, 'base64');
    expect(actual.equals(expected)).toBe(true);
  });
});
