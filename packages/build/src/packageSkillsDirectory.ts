import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { basename, join, posix } from 'node:path';
import {
  brandPackagedSkill,
  classifySkillFileKind,
  parseSkillFrontmatter,
  type PackagedSkill,
  type PackagedSkillFile,
} from '@kuralle-agents/core';

const SKIP_DIR_NAMES = new Set([
  'node_modules',
  '.git',
  '.cache',
  '.turbo',
  '.wrangler',
  'dist',
]);

const SENSITIVE_DIR_NAMES = new Set(['.ssh', '.aws', '.gnupg']);

const SKIP_FILE_NAMES = new Set(['.DS_Store']);

const SENSITIVE_FILE_NAMES = new Set([
  '.netrc',
  '_netrc',
  '.npmrc',
  '.pypirc',
  'credentials.json',
]);

const SENSITIVE_EXTENSIONS = new Set(['.key', '.pem', '.p12', '.pfx']);

const SKIP_FILE_PATTERNS = [/\.swp$/, /\.swo$/, /~$/];

const ONE_MB = 1024 * 1024;

function isSensitiveDirName(name: string): boolean {
  return SENSITIVE_DIR_NAMES.has(name.toLowerCase());
}

/**
 * Every comparison here is case-folded, deliberately. macOS and Windows are
 * case-insensitive by default, so `.ENV` and `.env` are the *same file* on the
 * machines most authors use — matching case-sensitively would refuse one and
 * happily package the other.
 */
function isSensitiveFileName(name: string): boolean {
  const lower = name.toLowerCase();
  if (SENSITIVE_FILE_NAMES.has(lower)) return true;
  if (lower.startsWith('secret')) return true;
  if (lower === '.env' || lower.startsWith('.env.')) {
    return true;
  }
  if (lower.startsWith('.dev.vars')) {
    return true;
  }
  const base = basename(lower);
  const ext = base.includes('.') ? `.${base.split('.').pop()}` : '';
  if (SENSITIVE_EXTENSIONS.has(ext)) return true;
  return false;
}

function shouldSkipDir(name: string): boolean {
  return SKIP_DIR_NAMES.has(name);
}

function shouldSkipFile(name: string): boolean {
  if (SKIP_FILE_NAMES.has(name)) return true;
  return SKIP_FILE_PATTERNS.some((pattern) => pattern.test(name));
}

function computeSkillId(name: string, files: Readonly<Record<string, PackagedSkillFile>>): string {
  const hash = createHash('sha256');
  const paths = Object.keys(files).sort();
  for (const path of paths) {
    const pathBytes = Buffer.from(path, 'utf8');
    const contentBytes = Buffer.from(files[path].content, 'base64');
    const pathLen = Buffer.alloc(4);
    pathLen.writeUInt32BE(pathBytes.length, 0);
    const contentLen = Buffer.alloc(4);
    contentLen.writeUInt32BE(contentBytes.length, 0);
    hash.update(pathLen);
    hash.update(contentLen);
    hash.update(pathBytes);
    hash.update(contentBytes);
  }
  return `skill:${name}:${hash.digest('hex').slice(0, 16)}`;
}

async function collectSkillFiles(
  skillDir: string,
  skillEntryName: string,
  relPrefix: string,
  out: Map<string, Uint8Array>,
): Promise<void> {
  const entries = await readdir(skillDir, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
    const fullPath = join(skillDir, entry.name);

    if (entry.isSymbolicLink()) {
      throw new Error(`[skills] Refusing to package symbolic link "${posix.join(skillEntryName, rel)}".`);
    }

    if (entry.isDirectory()) {
      if (isSensitiveDirName(entry.name)) {
        throw new Error(`[skills] Refusing to package sensitive directory "${posix.join(skillEntryName, rel)}".`);
      }
      if (shouldSkipDir(entry.name)) {
        console.warn(`[skills] Skipping directory "${posix.join(skillEntryName, rel)}".`);
        continue;
      }
      await collectSkillFiles(fullPath, skillEntryName, rel, out);
      continue;
    }

    if (!entry.isFile()) continue;

    if (shouldSkipFile(entry.name)) {
      console.warn(`[skills] Skipping file "${posix.join(skillEntryName, rel)}".`);
      continue;
    }

    if (isSensitiveFileName(entry.name)) {
      throw new Error(`[skills] Refusing to package sensitive file "${posix.join(skillEntryName, rel)}".`);
    }

    const bytes = await readFile(fullPath);
    if (bytes.length > ONE_MB) {
      console.warn(`[skills] Packaging large file (${bytes.length} bytes) "${posix.join(skillEntryName, rel)}".`);
    }
    out.set(rel.replace(/\\/g, '/'), bytes);
  }
}

async function packageOneSkill(root: string, entryName: string): Promise<PackagedSkill | undefined> {
  const skillDir = join(root, entryName);
  const skillMdPath = join(skillDir, 'SKILL.md');

  let stat;
  try {
    stat = await lstat(skillMdPath);
  } catch {
    return undefined;
  }

  if (stat.isSymbolicLink()) {
    throw new Error(`[skills] Refusing to package symbolic link "${posix.join(entryName, 'SKILL.md')}".`);
  }

  const rawContent = await readFile(skillMdPath);
  const parsed = parseSkillFrontmatter(rawContent.toString('utf8'), {
    path: posix.join(entryName, 'SKILL.md'),
    directoryName: entryName,
  });

  const fileBytes = new Map<string, Uint8Array>();
  await collectSkillFiles(skillDir, entryName, '', fileBytes);

  const files: Record<string, PackagedSkillFile> = Object.create(null);
  for (const [path, bytes] of [...fileBytes.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    files[path] = {
      path,
      encoding: 'base64',
      kind: classifySkillFileKind(bytes),
      content: Buffer.from(bytes).toString('base64'),
    };
  }

  const skill: PackagedSkill = {
    id: computeSkillId(parsed.name, files),
    name: parsed.name,
    description: parsed.description,
    ...(parsed.allowedTools ? { allowedTools: parsed.allowedTools } : {}),
    files,
  };

  return brandPackagedSkill(skill);
}

export async function packageSkillsDirectory(root: string): Promise<PackagedSkill[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const skills: PackagedSkill[] = [];

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink()) {
      const skillMdPath = join(root, entry.name, 'SKILL.md');
      try {
        await lstat(skillMdPath);
        throw new Error(`[skills] Refusing to package symbolic link "${entry.name}".`);
      } catch (err) {
        if (err instanceof Error && err.message.includes('symbolic link')) {
          throw err;
        }
        // Loose symlink at the skills root outside any skill package — not packaged, not an error.
        continue;
      }
    }

    if (!entry.isDirectory()) continue;

    const skill = await packageOneSkill(root, entry.name);
    if (skill) skills.push(skill);
  }

  return skills;
}
