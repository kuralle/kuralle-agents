export const PAGE_META_KEY = 'page';
export const CHUNK_INDEX_META_KEY = 'chunk_index';
export const PATH_TREE_MANIFEST_ID = '__path_tree__';

export type PathTreeManifest = Record<string, { isPublic?: boolean; groups?: string[] }>;

export interface ChunkRecord {
  id: string;
  slug: string;
  chunkIndex: number;
  text: string;
}

export interface PathTreeData {
  files: Set<string>;
  dirChildren: Map<string, string[]>;
}

export function normalizeKnowledgePath(path: string): string {
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

  return resolved.length === 0 ? '/' : `/${resolved.join('/')}`;
}

export function joinKnowledgePath(parent: string, child: string): string {
  const base = normalizeKnowledgePath(parent);
  if (child.startsWith('/')) return normalizeKnowledgePath(child);
  return normalizeKnowledgePath(base === '/' ? `/${child}` : `${base}/${child}`);
}

export function resolveKnowledgePath(base: string, path: string): string {
  if (path.startsWith('/')) return normalizeKnowledgePath(path);
  return joinKnowledgePath(base, path);
}

export function pathUnderRoot(path: string, root: string): boolean {
  const p = normalizeKnowledgePath(path);
  const r = normalizeKnowledgePath(root);
  if (r === '/') return true;
  return p === r || p.startsWith(`${r}/`);
}

export function buildPathTree(slugs: Iterable<string>): PathTreeData {
  const files = new Set<string>();
  const dirChildren = new Map<string, Set<string>>();

  const addChild = (dir: string, name: string) => {
    const normalizedDir = normalizeKnowledgePath(dir);
    if (!dirChildren.has(normalizedDir)) {
      dirChildren.set(normalizedDir, new Set());
    }
    dirChildren.get(normalizedDir)!.add(name);
  };

  for (const raw of slugs) {
    const slug = normalizeKnowledgePath(raw);
    if (slug === '/') continue;
    files.add(slug);

    const parts = slug.slice(1).split('/');
    let current = '/';
    for (let i = 0; i < parts.length; i++) {
      addChild(current, parts[i]!);
      if (i < parts.length - 1) {
        current = joinKnowledgePath(current, parts[i]!);
      }
    }
  }

  const sorted = new Map<string, string[]>();
  for (const [dir, children] of dirChildren) {
    sorted.set(dir, [...children].sort());
  }
  return { files, dirChildren: sorted };
}

export function prunePathTree(
  tree: PathTreeData,
  allow: (slug: string) => boolean,
): PathTreeData {
  const keptFiles = new Set<string>();
  for (const file of tree.files) {
    if (allow(file)) keptFiles.add(file);
  }
  return buildPathTree(keptFiles);
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
    } else if ('.+^${}()|[]\\'.includes(ch)) {
      re += `\\${ch}`;
      i++;
    } else {
      re += ch;
      i++;
    }
  }
  re += '$';
  return new RegExp(re);
}

export function chunkRecordsFromEntries(
  entries: Array<{
    id: string;
    metadata?: Record<string, unknown>;
    document?: string;
  }>,
): ChunkRecord[] {
  const records: ChunkRecord[] = [];
  for (const entry of entries) {
    const meta = entry.metadata ?? {};
    const page = meta[PAGE_META_KEY];
    const chunkIndex = meta[CHUNK_INDEX_META_KEY];
    if (typeof page !== 'string' || page.length === 0) continue;
    if (typeof chunkIndex !== 'number' || !Number.isFinite(chunkIndex)) continue;
    const slug = normalizeKnowledgePath(page);
    records.push({
      id: entry.id,
      slug,
      chunkIndex,
      text: entry.document ?? '',
    });
  }
  return records;
}

export function groupChunksBySlug(records: ChunkRecord[]): Map<string, ChunkRecord[]> {
  const map = new Map<string, ChunkRecord[]>();
  for (const record of records) {
    const list = map.get(record.slug) ?? [];
    list.push(record);
    map.set(record.slug, list);
  }
  for (const [, list] of map) {
    list.sort((a, b) => a.chunkIndex - b.chunkIndex);
  }
  return map;
}

export function parsePathTreeManifest(raw: string): string[] {
  const parsed = JSON.parse(raw) as PathTreeManifest;
  return Object.keys(parsed).map((k) =>
    normalizeKnowledgePath(k.startsWith('/') ? k : `/${k}`),
  );
}

export function allChunkRecords(map: Map<string, ChunkRecord[]>): ChunkRecord[] {
  const out: ChunkRecord[] = [];
  for (const list of map.values()) out.push(...list);
  return out;
}
