import { z } from 'zod';
import { defineTool } from '../effect/defineTool.js';
import type { AnyTool } from '../../types/effectTool.js';
import { fsErrorCode, type FileSystem } from '../../types/filesystem.js';

export interface CreateFsToolOptions {
  fs: FileSystem;
  readOnly?: boolean;
  timeoutMs?: number;
}

const DEFAULT_READ_ONLY = true;

export interface GrepHit {
  path: string;
  line: number;
  text: string;
}

export interface FsSearchHit {
  slug: string;
  chunkIndex: number;
  text: string;
}

export interface FsWithSearch extends FileSystem {
  search?(
    pattern: string,
    opts?: { limit?: number; path?: string },
  ): Promise<FsSearchHit[]>;
}

const workspaceInput = z.object({
  op: z.enum(['ls', 'cat', 'grep', 'find', 'read', 'write', 'edit']),
  path: z.string().optional(),
  pattern: z.string().optional(),
  root: z.string().optional(),
  glob: z.string().optional(),
  flags: z.string().optional(),
  content: z.string().optional(),
  find: z.string().optional(),
  replace: z.string().optional(),
});

type WorkspaceInput = z.infer<typeof workspaceInput>;

function normalizeFsPath(path: string | undefined, fallback = '/'): string {
  if (!path || path.trim() === '') return fallback;
  return path;
}

function requireField<T extends WorkspaceInput>(
  args: T,
  field: keyof T,
  op: string,
): string {
  const value = args[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`EINVAL: missing ${String(field)} for workspace op '${op}'`);
  }
  return value;
}

function eroFs(path: string): Error {
  return new Error(`EROFS: read-only filesystem, write '${path}'`);
}

function assertWritable(readOnly: boolean, path: string): void {
  if (readOnly) throw eroFs(path);
}

async function listFiles(fs: FileSystem, root: string): Promise<string[]> {
  const normalized = root === '' ? '/' : root;
  const out: string[] = [];
  const stack = [normalized];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    if (!(await fs.exists(dir))) {
      throw new Error(`ENOENT: no such file or directory, find '${dir}'`);
    }
    const stat = await fs.stat(dir);
    if (stat.type !== 'directory') {
      out.push(dir);
      continue;
    }
    const entries = await fs.readdirWithFileTypes(dir);
    for (const entry of entries) {
      const child = fs.resolvePath(dir, entry.name);
      if (entry.type === 'directory') {
        stack.push(child);
      } else {
        out.push(child);
      }
    }
  }
  return out.sort();
}

async function grepFiles(
  fs: FileSystem,
  pattern: string,
  root: string,
  flags?: string,
): Promise<GrepHit[]> {
  let re: RegExp;
  try {
    re = new RegExp(pattern, flags?.includes('i') ? 'i' : undefined);
  } catch {
    throw new Error(`EINVAL: invalid grep pattern '${pattern}'`);
  }

  const searchable = fs as FsWithSearch;
  if (searchable.search) {
    const coarse = await searchable.search(pattern, { limit: 500, path: root });
    const slugs = [...new Set(coarse.map((hit) => hit.slug))];
    const hits: GrepHit[] = [];
    for (const filePath of slugs) {
      let content: string;
      try {
        content = await fs.readFile(filePath);
      } catch (err) {
        if (fsErrorCode(err) === 'EISDIR') continue;
        throw err;
      }
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i]!)) {
          hits.push({ path: filePath, line: i + 1, text: lines[i]! });
        }
      }
    }
    return hits;
  }

  const candidates = await listFiles(fs, root);
  const hits: GrepHit[] = [];
  for (const filePath of candidates) {
    let content: string;
    try {
      content = await fs.readFile(filePath);
    } catch (err) {
      if (fsErrorCode(err) === 'EISDIR') continue;
      throw err;
    }
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i]!)) {
        hits.push({ path: filePath, line: i + 1, text: lines[i]! });
      }
    }
  }
  return hits;
}

/**
 * One durable `workspace` tool over a {@link FileSystem} (ls/cat/grep/find/read/write/edit).
 * Lives in core (not `@kuralle-agents/fs`) because it needs only `defineTool` + the
 * `FileSystem` interface — both core-owned — so the runtime can auto-register it with a
 * static import and no core->fs dependency (RFC-02 §5.2). `@kuralle-agents/fs` re-exports it.
 */
export function createFsTool(opts: CreateFsToolOptions): AnyTool {
  const { fs, readOnly = DEFAULT_READ_ONLY, timeoutMs } = opts;

  return defineTool({
    name: 'workspace',
    description:
      'Explore and edit the agent workspace. Ops: ls, cat, grep, find, read, write, edit.',
    timeoutMs,
    input: workspaceInput,
    execute: async (args: WorkspaceInput) => {
      switch (args.op) {
        case 'ls': {
          const path = normalizeFsPath(args.path);
          const entries = await fs.readdirWithFileTypes(path);
          return {
            op: args.op,
            ok: true as const,
            path,
            entries,
          };
        }
        case 'cat':
        case 'read': {
          const path = requireField(args, 'path', args.op);
          const content = await fs.readFile(path);
          return { op: args.op, ok: true as const, path, content };
        }
        case 'find': {
          const root = normalizeFsPath(args.root);
          const glob = requireField(args, 'glob', args.op);
          const paths = await fs.glob(glob);
          const rooted = paths.filter((p) => {
            const normalizedRoot = root === '/' ? '/' : root.replace(/\/$/, '');
            return p === normalizedRoot || p.startsWith(`${normalizedRoot}/`);
          });
          return {
            op: args.op,
            ok: true as const,
            root,
            glob,
            paths: rooted,
          };
        }
        case 'grep': {
          const pattern = requireField(args, 'pattern', args.op);
          const path = normalizeFsPath(args.path);
          const hits = await grepFiles(fs, pattern, path, args.flags);
          return {
            op: args.op,
            ok: true as const,
            pattern,
            path,
            hits,
          };
        }
        case 'write': {
          const path = requireField(args, 'path', args.op);
          const content = requireField(args, 'content', args.op);
          assertWritable(readOnly, path);
          await fs.writeFile(path, content);
          return { op: args.op, ok: true as const, path };
        }
        case 'edit': {
          const path = requireField(args, 'path', args.op);
          const find = requireField(args, 'find', args.op);
          const replace = requireField(args, 'replace', args.op);
          assertWritable(readOnly, path);
          const current = await fs.readFile(path);
          if (!current.includes(find)) {
            throw new Error(
              `ENOENT: find string not found in file, edit '${path}'`,
            );
          }
          const next = current.replace(find, replace);
          await fs.writeFile(path, next);
          return { op: args.op, ok: true as const, path };
        }
        default: {
          throw new Error(`EINVAL: unknown workspace op '${String(args.op)}'`);
        }
      }
    },
  });
}
