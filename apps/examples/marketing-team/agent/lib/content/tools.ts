import { defineTool, RecoverableToolError } from '@kuralle-agents/core';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { markdownToTiptap } from '../../../db/content-format.js';
import { contentKind, contentPieces, contentRevisions, contentStatus } from '../../../db/schema.js';
import { actingAgent, resolveScope, type Db, type ResolveWorkspaceScope } from '../workspace-scope.js';

export interface ContentToolsDeps {
  db: Db;
  resolveScope: ResolveWorkspaceScope;
}

const kind = z.enum(contentKind.enumValues);
const status = z.enum(contentStatus.enumValues);
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const slug = z.string().min(1).max(80).regex(SLUG, 'lowercase letters, numbers, and single hyphens only');

/**
 * Page metadata, passed as its own arguments rather than smuggled through `markdown`.
 *
 * ~150 characters is the length the blog-style skill teaches (mobile truncates around 120), so
 * the bound is the guidance made enforceable rather than an arbitrary cap.
 */
const metaDescription = z
  .string()
  .max(200)
  .describe('SEO meta description, ~150 characters or under. Never put this in the body.')
  .optional();
const targetQuery = z
  .string()
  .max(120)
  .describe('The search query this piece targets. Never put this in the body.')
  .optional();

/**
 * Keeps page metadata out of the body, in whichever shape the model tries to smuggle it.
 *
 * First a blog piece arrived with `---\nmeta_description: …\n---` on top. prosemirror-markdown
 * has no front-matter concept — correctly, it is not markdown — so the delimiters parsed as a
 * thematic break and the fields as a heading, and the editor rendered both as content. Once that
 * was rejected the very next draft appended the same information as a trailing
 * `Meta description: …` / `Target query: …` block after a rule instead.
 *
 * That second attempt is the important one: it says the model was not being sloppy. The
 * blog-style skill teaches that this metadata is part of the deliverable, and it kept finding a
 * carrier because it had something real to deliver and nowhere to put it. Closing carriers one
 * at a time is whack-a-mole. `content_pieces.meta_description` / `.target_query` and the
 * matching tool arguments are the actual fix; this guard is what makes the body field stop being
 * an alternative, and its message points at the arguments so a model that reaches for the body
 * is told exactly where the data goes.
 *
 * Both detectors look at structure rather than at the word "meta": front matter is a fenced
 * block of `key: value` lines at the very top (a document may legitimately *open* with a
 * thematic break, so the delimiters alone are not enough), and the trailer is a run of
 * `Known Field:` lines at the very bottom.
 */

const FRONT_MATTER_FIELD = /^[A-Za-z_][\w-]*\s*:/;

/** A `---` fenced block of `key: value` lines at the very top. */
function findFrontMatter(markdown: string): string[] | null {
  const lines = markdown.split(/\r?\n/);
  let start = 0;
  while (start < lines.length && lines[start]!.trim() === '') start++;
  if (lines[start]?.trim() !== '---') return null;

  for (let end = start + 1; end < lines.length; end++) {
    if (lines[end]!.trim() !== '---') continue;
    const enclosed = lines.slice(start + 1, end).filter((l) => l.trim() !== '');
    if (enclosed.length > 0 && enclosed.every((l) => FRONT_MATTER_FIELD.test(l.trim()))) {
      return enclosed;
    }
    return null;
  }
  return null;
}

/**
 * A metadata appendix: the block after the document's final thematic break, when that block is
 * made of `Label: value` lines (with list items allowed between them).
 *
 * This is deliberately shape-based rather than a list of known labels. Three rounds of
 * vocabulary matching lost to the model each time: `meta_description:` in front matter became
 * `Meta description:` at the bottom, which became `**Meta description:**`, which became
 * `Internal links suggested:` — a label one word away from every pattern written to catch it.
 * The shape is what is stable. A blog body does not end with a rule followed by a run of
 * `Label: value` lines; an appended notes block always does.
 *
 * Requiring at least one `Label: value` line is what keeps an ordinary closing section — a rule
 * followed by a last paragraph — from tripping it.
 */
// The value is optional: `Internal links:` introduces a list and is a label line just as much
// as `Target query: …` is. Capping the label at 40 characters and disallowing sentence
// punctuation inside it is what separates these from ordinary prose that happens to end in a
// colon.
const LABELLED_LINE = /^[A-Za-z][A-Za-z0-9 _-]{0,40}:\s*(?:\S.*)?$/;

function stripEmphasis(line: string): string {
  return line.replace(/^[#>\s]*/, '').replace(/[*_`]/g, '').trim();
}

function findTrailingMetadata(markdown: string): string[] | null {
  const lines = markdown.split(/\r?\n/);

  let rule = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.trim() === '---') {
      rule = i;
      break;
    }
  }
  if (rule === -1) return null;

  const labelled: string[] = [];
  for (const raw of lines.slice(rule + 1)) {
    const line = stripEmphasis(raw);
    if (line === '') continue;
    // List items and bare links are the body of the appendix, not its labels.
    if (/^[-*]\s/.test(line) || /^\[.+\]\(.+\)$/.test(line)) continue;
    if (LABELLED_LINE.test(line)) {
      labelled.push(line);
      continue;
    }
    // Ordinary prose after the rule: this is a real closing section, not an appendix.
    return null;
  }
  return labelled.length > 0 ? labelled : null;
}

function assertBodyOnly(markdown: string): void {
  const fields = findFrontMatter(markdown) ?? findTrailingMetadata(markdown);
  if (!fields) return;
  const names = fields.map((line) => line.trim().split(':')[0]).join(', ');
  throw new RecoverableToolError(
    `This markdown carries page metadata (${names}) inside the body, where it is stored and ` +
      'rendered as prose. Send the body only, and pass the metadata as its own arguments: ' +
      '`metaDescription` and `targetQuery`. Internal links belong inline in the body as real ' +
      'markdown links, not as a list at the end.',
    { userMessage: 'The draft had its SEO metadata written into the text, so I asked for it separately.' },
  );
}

/** Postgres `unique_violation`. The `(workspace_id, slug)` index is the only one that can fire here. */
const UNIQUE_VIOLATION = '23505';

/**
 * Walks the `cause` chain rather than reading `error.code` off the top.
 *
 * Drizzle wraps every driver failure in a `DrizzleQueryError` whose own `code` is undefined and
 * whose `message` is the full SQL plus bound parameters; the `PostgresError` carrying `23505`
 * sits underneath on `cause`. A top-level check compiles, typechecks, and silently never
 * matches — which is how the raw statement reached the model in the first place.
 */
function isUniqueViolation(error: unknown): boolean {
  for (let current = error, depth = 0; current && depth < 5; depth++) {
    if (typeof current === 'object' && (current as { code?: unknown }).code === UNIQUE_VIOLATION) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * The Notion replacement. Agents always pass Markdown; `body_json` (Tiptap) is derived from
 * it and both columns are written together in the same transaction, alongside an append-only
 * `content_revisions` row — never one column without the other, and never a silent edit.
 */
export function createContentTools(deps: ContentToolsDeps) {
  const { db, resolveScope: resolve } = deps;

  const create_content = defineTool({
    name: 'create_content',
    description: 'Create a new content piece from Markdown.',
    input: z.object({
      kind,
      title: z.string().min(1).max(200),
      slug,
      markdown: z.string().min(1).max(200_000),
      metaDescription,
      targetQuery,
    }),
    execute: async ({ kind: k, title, slug: s, markdown, metaDescription: meta, targetQuery: query }, ctx) => {
      assertBodyOnly(markdown);
      const { workspaceId } = await resolveScope(resolve, ctx);
      const authoredByAgent = actingAgent(ctx);
      const bodyJson = markdownToTiptap(markdown);

      return db.transaction(async (tx) => {
        let saved;
        try {
          [saved] = await tx
            .insert(contentPieces)
            .values({
              workspaceId,
              kind: k,
              title,
              slug: s,
              bodyJson,
              bodyMarkdown: markdown,
              metaDescription: meta ?? null,
              targetQuery: query ?? null,
              authoredByAgent,
            })
            .returning();
        } catch (error) {
          // `(workspace_id, slug)` is unique. Without this the driver's raw failure — the full
          // INSERT statement and every bound parameter, including the entire document body —
          // is what reaches the model, and from there the user's screen. It is also not
          // actionable: nothing in that text says which piece already holds the slug.
          //
          // A collision almost always means the piece already exists and the intent was to
          // revise it, so the recovery is to name the existing id and let the model choose
          // between `update_content` and a genuinely different slug. Auto-suffixing to
          // `…-2` would silently create a near-duplicate and hide that choice.
          if (!isUniqueViolation(error)) throw error;
          const [existing] = await db
            .select({ id: contentPieces.id, title: contentPieces.title })
            .from(contentPieces)
            .where(and(eq(contentPieces.workspaceId, workspaceId), eq(contentPieces.slug, s)))
            .limit(1);
          throw new RecoverableToolError(
            existing
              ? `The slug "${s}" is already used by "${existing.title}" (id ${existing.id}). ` +
                'Call update_content with that id to revise it, or create this piece under a different slug.'
              : `The slug "${s}" is already used in this workspace. Choose a different slug.`,
            { userMessage: `There is already a piece at "${s}".` },
          );
        }
        if (!saved) {
          throw new Error('create_content: insert returned no row');
        }
        await tx.insert(contentRevisions).values({
          workspaceId,
          contentPieceId: saved.id,
          bodyJson,
          bodyMarkdown: markdown,
          editedByAgent: authoredByAgent,
        });
        return { id: saved.id, slug: saved.slug, status: saved.status };
      });
    },
  });

  const update_content = defineTool({
    name: 'update_content',
    description: 'Replace an existing content piece’s body from Markdown, recording the prior version.',
    input: z.object({
      id: z.uuid(),
      markdown: z.string().min(1).max(200_000),
      metaDescription,
      targetQuery,
    }),
    execute: async ({ id, markdown, metaDescription: meta, targetQuery: query }, ctx) => {
      assertBodyOnly(markdown);
      const { workspaceId } = await resolveScope(resolve, ctx);
      const editedByAgent = actingAgent(ctx);
      const bodyJson = markdownToTiptap(markdown);

      return db.transaction(async (tx) => {
        const [updated] = await tx
          .update(contentPieces)
          .set({
            bodyJson,
            bodyMarkdown: markdown,
            // Only overwrite when supplied, so a body-only revision does not silently clear
            // metadata a previous call set.
            ...(meta !== undefined ? { metaDescription: meta } : {}),
            ...(query !== undefined ? { targetQuery: query } : {}),
            updatedAt: new Date(),
          })
          .where(and(eq(contentPieces.id, id), eq(contentPieces.workspaceId, workspaceId)))
          .returning();
        if (!updated) {
          return { found: false as const };
        }
        await tx.insert(contentRevisions).values({
          workspaceId,
          contentPieceId: updated.id,
          bodyJson,
          bodyMarkdown: markdown,
          editedByAgent,
        });
        return { found: true as const, id: updated.id, slug: updated.slug, status: updated.status };
      });
    },
  });

  const get_content = defineTool({
    name: 'get_content',
    description: 'Read one content piece by id, including its current Markdown body.',
    input: z.object({ id: z.uuid() }),
    execute: async ({ id }, ctx) => {
      const { workspaceId } = await resolveScope(resolve, ctx);
      const [row] = await db
        .select()
        .from(contentPieces)
        .where(and(eq(contentPieces.id, id), eq(contentPieces.workspaceId, workspaceId)))
        .limit(1);
      if (!row) {
        return { found: false as const };
      }
      return {
        found: true as const,
        id: row.id,
        kind: row.kind,
        title: row.title,
        slug: row.slug,
        status: row.status,
        bodyMarkdown: row.bodyMarkdown,
        updatedAt: row.updatedAt.toISOString(),
      };
    },
  });

  const list_content = defineTool({
    name: 'list_content',
    description: 'List content pieces in the workspace, optionally filtered by kind and/or status.',
    input: z.object({ kind: kind.optional(), status: status.optional() }),
    execute: async ({ kind: k, status: st }, ctx) => {
      const { workspaceId } = await resolveScope(resolve, ctx);
      const conditions = [eq(contentPieces.workspaceId, workspaceId)];
      if (k) conditions.push(eq(contentPieces.kind, k));
      if (st) conditions.push(eq(contentPieces.status, st));
      const rows = await db
        .select()
        .from(contentPieces)
        .where(and(...conditions));
      return {
        content: rows.map((row) => ({
          id: row.id,
          kind: row.kind,
          title: row.title,
          slug: row.slug,
          status: row.status,
          updatedAt: row.updatedAt.toISOString(),
        })),
      };
    },
  });

  const set_content_status = defineTool({
    name: 'set_content_status',
    description: 'Change a content piece’s status (draft, in-review, approved, published).',
    input: z.object({ id: z.uuid(), status }),
    execute: async ({ id, status: st }, ctx) => {
      const { workspaceId } = await resolveScope(resolve, ctx);
      const [updated] = await db
        .update(contentPieces)
        .set({ status: st, updatedAt: new Date() })
        .where(and(eq(contentPieces.id, id), eq(contentPieces.workspaceId, workspaceId)))
        .returning();
      if (!updated) {
        return { found: false as const };
      }
      return { found: true as const, id: updated.id, status: updated.status };
    },
  });

  return { create_content, update_content, get_content, list_content, set_content_status };
}
