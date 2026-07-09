// Open Knowledge Format (OKF v0.1) support — https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf
//
// An OKF bundle is "just markdown + YAML frontmatter + files": a directory of
// concept documents that link into a graph. That is exactly a `FileSystem`, so
// kuralle agents consume OKF through the ordinary `workspace` tool (ls/cat/grep)
// with no adapter. These helpers build a bundle into an InMemoryFs and read one
// back (the "consumption agent" side of the spec, §9 permissive consumption).
import type { FileSystem } from '@kuralle-agents/core';
import { InMemoryFs } from './in-memory-fs.js';

const RESERVED = new Set(['index.md', 'log.md']);
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)([\s\S]*)$/;
const LINK_RE = /\[[^\]]*\]\(([^)]+)\)/g;

export interface OkfConcept {
  /** Concept ID = file path minus `.md` (spec §2). */
  id: string;
  /** REQUIRED per spec §4.1 / §9. */
  type: string;
  title?: string;
  description?: string;
  resource?: string;
  tags?: string[];
  timestamp?: string;
  body: string;
  /** Bundle-relative links to other concepts (the graph edges, §5). */
  links: string[];
}

/** Parse one OKF concept document. Throws only when `type` is missing (the sole hard rule, §9). */
export function parseOkfConcept(content: string, id: string): OkfConcept {
  const stripped = content.replace(/^﻿/, '');
  const match = stripped.match(FRONTMATTER_RE);
  if (!match) {
    throw new Error(`OKF: concept "${id}" is missing YAML frontmatter.`);
  }
  const fm = parseFlatYaml(match[1] ?? '');
  const type = typeof fm.type === 'string' ? fm.type.trim() : '';
  if (!type) {
    throw new Error(`OKF: concept "${id}" frontmatter must define a non-empty "type" (spec §9).`);
  }
  const body = (match[2] ?? '').replace(/^\n/, '');
  const links = extractBundleLinks(body);
  const concept: OkfConcept = { id, type, body, links };
  const title = str(fm.title);
  const description = str(fm.description);
  const resource = str(fm.resource);
  const timestamp = str(fm.timestamp);
  if (title) concept.title = title;
  if (description) concept.description = description;
  if (resource) concept.resource = resource;
  if (Array.isArray(fm.tags)) concept.tags = fm.tags.map(String);
  if (timestamp) concept.timestamp = timestamp;
  return concept;
}

/**
 * List every concept in a bundle (skips reserved index.md/log.md). Permissive
 * per §9: a concept whose frontmatter is unparseable or lacks `type` is skipped,
 * not fatal — a partially-generated bundle stays consumable.
 */
export async function listOkfConcepts(
  fs: FileSystem,
  root = '/',
): Promise<OkfConcept[]> {
  const out: OkfConcept[] = [];
  const stack = [root === '' ? '/' : root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: Array<{ name: string; type: string }>;
    try {
      entries = await fs.readdirWithFileTypes(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = fs.resolvePath(dir, entry.name);
      if (entry.type === 'directory') {
        stack.push(full);
        continue;
      }
      if (!entry.name.endsWith('.md') || RESERVED.has(entry.name)) continue;
      const id = full.replace(/^\//, '').replace(/\.md$/, '');
      try {
        out.push(parseOkfConcept(await fs.readFile(full), id));
      } catch {
        // §9: tolerate non-conformant documents; skip rather than fail the bundle.
      }
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** Build an OKF bundle into an InMemoryFs from a `{ path: content }` map. */
export function okfBundleToFs(files: Record<string, string>, mountRoot = ''): FileSystem {
  const seeded: Record<string, string> = {};
  for (const [path, content] of Object.entries(files)) {
    const p = path.startsWith('/') ? path : `/${path}`;
    seeded[`${mountRoot}${p}`] = content;
  }
  return new InMemoryFs(seeded);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/** Bundle-relative links only (`/tables/x.md`) — the concept graph, ignoring external URLs. */
function extractBundleLinks(body: string): string[] {
  const links = new Set<string>();
  let m: RegExpExecArray | null;
  LINK_RE.lastIndex = 0;
  while ((m = LINK_RE.exec(body)) !== null) {
    const target = (m[1] ?? '').trim();
    if (target.startsWith('/') && target.endsWith('.md')) {
      links.add(target.replace(/\.md$/, '').replace(/^\//, ''));
    }
  }
  return [...links];
}

/** Minimal flat-YAML frontmatter parse (scalars + `tags: [a, b]` / `- item` lists). No node:*, workerd-clean. */
function parseFlatYaml(yaml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = yaml.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === '') { i += 1; continue; }
    const km = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!km) { i += 1; continue; }
    const key = km[1]!;
    const rest = (km[2] ?? '').trim();
    if (rest.startsWith('[') && rest.endsWith(']')) {
      const inner = rest.slice(1, -1).trim();
      result[key] = inner === '' ? [] : inner.split(',').map((s) => scalar(s.trim()));
      i += 1;
      continue;
    }
    if (rest === '') {
      i += 1;
      const items: string[] = [];
      while (i < lines.length && /^\s+-\s+/.test(lines[i]!)) {
        items.push(scalar(lines[i]!.replace(/^\s+-\s+/, '')));
        i += 1;
      }
      result[key] = items.length > 0 ? items : '';
      continue;
    }
    result[key] = scalar(rest);
    i += 1;
  }
  return result;
}

function scalar(v: string): string {
  const t = v.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}
