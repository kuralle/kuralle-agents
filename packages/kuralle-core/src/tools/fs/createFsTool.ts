import { z } from 'zod';
import { defineTool } from '../effect/defineTool.js';
import type { AnyTool } from '../../types/effectTool.js';
import { fsErrorCode, type FileSystem } from '../../types/filesystem.js';

export interface CreateFsToolOptions {
  fs: FileSystem;
  readOnly?: boolean;
  timeoutMs?: number;
}

export interface GrepHit {
  path: string;
  line: number;
  text: string;
}

const workspaceInput = z.discriminatedUnion('op', [
  z.object({ op: z.literal('ls'), path: z.string().default('/') }),
  z.object({ op: z.literal('cat'), path: z.string() }),
  z.object({
    op: z.literal('grep'),
    pattern: z.string(),
    path: z.string().default('/'),
    flags: z.string().optional(),
  }),
  z.object({
    op: z.literal('find'),
    root: z.string().default('/'),
    glob: z.string(),
  }),
  z.object({ op: z.literal('read'), path: z.string() }),
  z.object({ op: z.literal('write'), path: z.string(), content: z.string() }),
  z.object({
    op: z.literal('edit'),
    path: z.string(),
    find: z.string(),
    replace: z.string(),
  }),
]);

type WorkspaceInput = z.infer<typeof workspaceInput>;

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
  const { fs, readOnly = false, timeoutMs } = opts;

  return defineTool({
    name: 'workspace',
    description:
      'Explore and edit the agent workspace. Ops: ls, cat, grep, find, read, write, edit.',
    timeoutMs,
    input: workspaceInput,
    execute: async (args: WorkspaceInput) => {
      switch (args.op) {
        case 'ls': {
          const entries = await fs.readdirWithFileTypes(args.path);
          return {
            op: args.op,
            ok: true as const,
            path: args.path,
            entries,
          };
        }
        case 'cat':
        case 'read': {
          const content = await fs.readFile(args.path);
          return { op: args.op, ok: true as const, path: args.path, content };
        }
        case 'find': {
          const paths = await fs.glob(args.glob);
          const rooted = paths.filter((p) => {
            const root = args.root === '/' ? '/' : args.root.replace(/\/$/, '');
            return p === root || p.startsWith(`${root}/`);
          });
          return {
            op: args.op,
            ok: true as const,
            root: args.root,
            glob: args.glob,
            paths: rooted,
          };
        }
        case 'grep': {
          const hits = await grepFiles(fs, args.pattern, args.path, args.flags);
          return {
            op: args.op,
            ok: true as const,
            pattern: args.pattern,
            path: args.path,
            hits,
          };
        }
        case 'write': {
          assertWritable(readOnly, args.path);
          await fs.writeFile(args.path, args.content);
          return { op: args.op, ok: true as const, path: args.path };
        }
        case 'edit': {
          assertWritable(readOnly, args.path);
          const current = await fs.readFile(args.path);
          if (!current.includes(args.find)) {
            throw new Error(
              `ENOENT: find string not found in file, edit '${args.path}'`,
            );
          }
          const next = current.replace(args.find, args.replace);
          await fs.writeFile(args.path, next);
          return { op: args.op, ok: true as const, path: args.path };
        }
        default: {
          const _exhaustive: never = args;
          throw new Error(`EINVAL: unknown workspace op '${String(_exhaustive)}'`);
        }
      }
    },
  });
}
