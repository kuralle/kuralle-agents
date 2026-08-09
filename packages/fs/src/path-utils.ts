export const MAX_SYMLINK_DEPTH = 40;
export const DEFAULT_DIR_MODE = 0o755;
export const DEFAULT_FILE_MODE = 0o644;
export const SYMLINK_MODE = 0o777;

export function normalizePath(path: string): string {
  if (!path || path === '/') return '/';

  let normalized =
    path.endsWith('/') && path !== '/' ? path.slice(0, -1) : path;

  if (!normalized.startsWith('/')) {
    normalized = `/${normalized}`;
  }

  const parts = normalized.split('/').filter((p) => p && p !== '.');
  const resolved: string[] = [];

  for (const part of parts) {
    if (part === '..') {
      resolved.pop();
    } else {
      resolved.push(part);
    }
  }

  return `/${resolved.join('/')}`;
}

export function validatePath(path: string, operation: string): void {
  if (path.includes('\0')) {
    throw new Error(`ENOENT: path contains null byte, ${operation} '${path}'`);
  }
}

export function dirname(path: string): string {
  const normalized = normalizePath(path);
  if (normalized === '/') return '/';
  const lastSlash = normalized.lastIndexOf('/');
  return lastSlash === 0 ? '/' : normalized.slice(0, lastSlash);
}

export function resolvePath(base: string, path: string): string {
  if (path.startsWith('/')) {
    return normalizePath(path);
  }
  const combined = base === '/' ? `/${path}` : `${base}/${path}`;
  return normalizePath(combined);
}

export function joinPath(parent: string, child: string): string {
  return parent === '/' ? `/${child}` : `${parent}/${child}`;
}

export function resolveSymlinkTarget(
  symlinkPath: string,
  target: string,
): string {
  if (target.startsWith('/')) {
    return normalizePath(target);
  }
  const dir = dirname(symlinkPath);
  return normalizePath(joinPath(dir, target));
}

export function createGlobMatcher(pattern: string): RegExp {
  let i = 0;
  let re = '^';
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        i += 2;
        if (pattern[i] === '/') {
          re += '(?:.+/)?';
          i++;
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
        i++;
      }
    } else if (ch === '?') {
      re += '[^/]';
      i++;
    } else if (ch === '[') {
      const close = pattern.indexOf(']', i + 1);
      if (close === -1) {
        re += '\\[';
        i++;
      } else {
        re += pattern.slice(i, close + 1);
        i = close + 1;
      }
    } else if (ch === '{') {
      const close = pattern.indexOf('}', i + 1);
      if (close === -1) {
        re += '\\{';
        i++;
      } else {
        const inner = pattern
          .slice(i + 1, close)
          .split(',')
          .join('|');
        re += `(?:${inner})`;
        i = close + 1;
      }
    } else {
      re += ch.replace(/[.+^$|\\()]/g, '\\$&');
      i++;
    }
  }
  re += '$';
  return new RegExp(re);
}

export function sortPaths(paths: string[]): string[] {
  return [...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Lexical containment: does `target` sit at or under `root`, by path string alone?
 *
 * Correct for a path that has not been created yet — an MCP `cwd` of `${PLUGIN_DATA}` is
 * a declaration, and the directory only exists later. Use `containsResolvedPath` for a
 * path you are about to read.
 */
export function containsPath(root: string, target: string): boolean {
  const normalizedRoot = normalizePath(root);
  const normalizedTarget = normalizePath(target);
  return (
    normalizedTarget === normalizedRoot ||
    normalizedTarget.startsWith(`${normalizedRoot}/`)
  );
}

/**
 * Containment against the filesystem-resolved paths, with symlinks followed.
 *
 * A failure to resolve counts as "not contained", so a missing path and an escaping
 * symlink give the same answer and no caller has to tell them apart to stay safe. That is
 * also why this must not be used on a path the caller intends to create later.
 */
export async function containsResolvedPath(
  fs: { realpath(path: string): Promise<string> },
  root: string,
  target: string,
): Promise<boolean> {
  let realRoot: string;
  let realTarget: string;
  try {
    realRoot = await fs.realpath(root);
    realTarget = await fs.realpath(target);
  } catch {
    return false;
  }
  return containsPath(realRoot, realTarget);
}
