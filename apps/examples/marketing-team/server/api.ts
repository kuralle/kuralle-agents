import { Hono, type Context } from 'hono';
import { and, eq } from 'drizzle-orm';
import { createAssetTools } from '../agent/lib/assets/tools.js';
import { createBrandContextTools } from '../agent/lib/brand-context/tools.js';
import { createContentTools } from '../agent/lib/content/tools.js';
import { tiptapToMarkdown, type TiptapDocument } from '../db/content-format.js';
import { brandContext, contentKind, contentPieces, contentStatus } from '../db/schema.js';
import { db } from '../db/client.js';
import { makeHumanToolContext } from './human-context.js';
import { getRuntime, marketingToolsDeps, resolveDefaultWorkspaceId } from './runtime.js';

type ContentStatus = (typeof contentStatus.enumValues)[number];

const CONVERSATION_PATTERN = /^[a-zA-Z0-9_-]{8,100}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The one legal forward path a piece of content moves through. Anything not listed here —
// backward, sideways, or skipping a step (draft -> published) — is rejected. Documented choice
// (workmanship rule on ambiguous specs): the task names the sequence but not what to do with a
// request outside it, so "reject everything but the next forward step" is the interpretation
// this route enforces, and `test/web/status-transitions.test.ts` pins it.
const FORWARD_TRANSITIONS: Partial<Record<ContentStatus, ContentStatus>> = {
  draft: 'in-review',
  'in-review': 'approved',
  approved: 'published',
};

function tools() {
  const deps = marketingToolsDeps();
  return {
    content: createContentTools(deps),
    brandContext: createBrandContextTools(deps),
    assets: createAssetTools(deps),
  };
}

async function safeJson<T>(c: Context): Promise<T> {
  try {
    return await c.req.json<T>();
  } catch {
    throw new Error('Request body must be valid JSON.');
  }
}

function extractLatestUserText(messages: unknown): string {
  if (!Array.isArray(messages)) return '';
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: unknown; parts?: unknown };
    if (message.role !== 'user' || !Array.isArray(message.parts)) continue;
    return message.parts
      .filter(
        (part): part is { type: 'text'; text: string } =>
          Boolean(part) &&
          typeof part === 'object' &&
          (part as { type?: unknown }).type === 'text' &&
          typeof (part as { text?: unknown }).text === 'string',
      )
      .map((part) => part.text)
      .join('\n')
      .trim();
  }
  return '';
}

export function createApi(): Hono {
  const app = new Hono();

  app.onError((error, c) => {
    console.error('API request failed', error);
    const message = process.env.NODE_ENV === 'production' ? 'The request could not be completed.' : error.message;
    return c.json({ error: message }, 500);
  });

  // --- chat -------------------------------------------------------------

  app.post('/chat', async (c) => {
    const body = await safeJson<{ id?: unknown; messages?: unknown }>(c);
    const conversationId = typeof body.id === 'string' ? body.id : '';
    if (!CONVERSATION_PATTERN.test(conversationId)) {
      return c.json({ error: 'A valid conversation id is required.' }, 400);
    }
    const input = extractLatestUserText(body.messages);
    if (!input) return c.json({ error: 'A user text message is required.' }, 400);

    const runtime = await getRuntime();
    const handle = runtime.run({ input, sessionId: conversationId });
    return handle.toUIMessageStreamResponse({ sessionId: conversationId });
  });

  // --- content library ----------------------------------------------------

  app.get('/content', async (c) => {
    const workspaceId = await resolveDefaultWorkspaceId();
    const kind = c.req.query('kind');
    const status = c.req.query('status');
    const conditions = [eq(contentPieces.workspaceId, workspaceId)];
    if (kind) {
      if (!contentKind.enumValues.includes(kind as (typeof contentKind.enumValues)[number])) {
        return c.json({ error: `kind must be one of: ${contentKind.enumValues.join(', ')}` }, 400);
      }
      conditions.push(eq(contentPieces.kind, kind as (typeof contentKind.enumValues)[number]));
    }
    if (status) {
      if (!contentStatus.enumValues.includes(status as ContentStatus)) {
        return c.json({ error: `status must be one of: ${contentStatus.enumValues.join(', ')}` }, 400);
      }
      conditions.push(eq(contentPieces.status, status as ContentStatus));
    }
    const rows = await db
      .select({
        id: contentPieces.id,
        kind: contentPieces.kind,
        title: contentPieces.title,
        slug: contentPieces.slug,
        status: contentPieces.status,
        authoredByAgent: contentPieces.authoredByAgent,
        updatedAt: contentPieces.updatedAt,
      })
      .from(contentPieces)
      .where(and(...conditions));
    return c.json({
      content: rows.map((row) => ({ ...row, updatedAt: row.updatedAt.toISOString() })),
    });
  });

  app.get('/content/:id', async (c) => {
    const workspaceId = await resolveDefaultWorkspaceId();
    const id = c.req.param('id');
    if (!UUID_PATTERN.test(id)) return c.json({ error: 'Not found' }, 404);
    const [row] = await db
      .select()
      .from(contentPieces)
      .where(and(eq(contentPieces.id, id), eq(contentPieces.workspaceId, workspaceId)))
      .limit(1);
    if (!row) return c.json({ error: 'Not found' }, 404);
    return c.json({
      id: row.id,
      kind: row.kind,
      title: row.title,
      slug: row.slug,
      status: row.status,
      bodyJson: row.bodyJson,
      metaDescription: row.metaDescription,
      targetQuery: row.targetQuery,
      authoredByAgent: row.authoredByAgent,
      updatedAt: row.updatedAt.toISOString(),
    });
  });

  app.put('/content/:id', async (c) => {
    const workspaceId = await resolveDefaultWorkspaceId();
    const id = c.req.param('id');
    if (!UUID_PATTERN.test(id)) return c.json({ error: 'Not found' }, 404);
    const body = await safeJson<{ json?: unknown }>(c);
    if (!body.json || typeof body.json !== 'object') {
      return c.json({ error: 'json is required.' }, 400);
    }

    const [current] = await db
      .select({ bodyMarkdown: contentPieces.bodyMarkdown, status: contentPieces.status })
      .from(contentPieces)
      .where(and(eq(contentPieces.id, id), eq(contentPieces.workspaceId, workspaceId)))
      .limit(1);
    if (!current) return c.json({ error: 'Not found' }, 404);

    const markdown = tiptapToMarkdown(body.json as TiptapDocument);

    // A save whose markdown round-trips to exactly what is already stored does not append a
    // revision. The editor's schema is a fixed point (test/web/editor-roundtrip.test.ts), so
    // an unedited open-then-save reaches this branch on every keystroke debounce; without it,
    // content_revisions would grow forever with no authored diff. Documented choice — the
    // alternative (always append) is equally defensible, but this one is what ships and what
    // test/web/save-api.test.ts pins.
    if (markdown === current.bodyMarkdown) {
      return c.json({ id, status: current.status, changed: false });
    }

    const { update_content } = tools().content;
    const result = (await update_content.execute({ id, markdown }, makeHumanToolContext())) as {
      found: boolean;
      id?: string;
      status?: ContentStatus;
    };
    if (!result.found) return c.json({ error: 'Not found' }, 404);
    return c.json({ id: result.id, status: result.status, changed: true });
  });

  app.post('/content/:id/status', async (c) => {
    const workspaceId = await resolveDefaultWorkspaceId();
    const id = c.req.param('id');
    if (!UUID_PATTERN.test(id)) return c.json({ error: 'Not found' }, 404);
    const body = await safeJson<{ status?: unknown }>(c);
    if (typeof body.status !== 'string' || !contentStatus.enumValues.includes(body.status as ContentStatus)) {
      return c.json({ error: `status must be one of: ${contentStatus.enumValues.join(', ')}` }, 400);
    }
    const target = body.status as ContentStatus;

    const [current] = await db
      .select({ status: contentPieces.status })
      .from(contentPieces)
      .where(and(eq(contentPieces.id, id), eq(contentPieces.workspaceId, workspaceId)))
      .limit(1);
    if (!current) return c.json({ error: 'Not found' }, 404);

    if (FORWARD_TRANSITIONS[current.status] !== target) {
      return c.json(
        { error: `Cannot move content from "${current.status}" to "${target}".` },
        400,
      );
    }

    const { set_content_status } = tools().content;
    const result = (await set_content_status.execute(
      { id, status: target },
      makeHumanToolContext(),
    )) as { found: boolean; id?: string; status?: ContentStatus };
    if (!result.found) return c.json({ error: 'Not found' }, 404);
    return c.json({ id: result.id, status: result.status });
  });

  // --- brand context -------------------------------------------------------

  app.get('/brand-context', async (c) => {
    const workspaceId = await resolveDefaultWorkspaceId();
    const [row] = await db.select().from(brandContext).where(eq(brandContext.workspaceId, workspaceId)).limit(1);
    if (!row) return c.json({ found: false });
    return c.json({
      found: true,
      bodyJson: row.bodyJson,
      updatedAt: row.updatedAt.toISOString(),
    });
  });

  app.put('/brand-context', async (c) => {
    const workspaceId = await resolveDefaultWorkspaceId();
    const body = await safeJson<{ json?: unknown }>(c);
    if (!body.json || typeof body.json !== 'object') {
      return c.json({ error: 'json is required.' }, 400);
    }
    const markdown = tiptapToMarkdown(body.json as TiptapDocument);

    const [current] = await db
      .select({ bodyMarkdown: brandContext.bodyMarkdown })
      .from(brandContext)
      .where(eq(brandContext.workspaceId, workspaceId))
      .limit(1);

    // Same "skip an unchanged save" choice as /content/:id above, for the same reason.
    if (current && current.bodyMarkdown === markdown) {
      return c.json({ changed: false });
    }

    const { save_brand_context } = tools().brandContext;
    const result = (await save_brand_context.execute({ markdown }, makeHumanToolContext())) as {
      id: string;
      updatedAt: string;
    };
    return c.json({ ...result, changed: true });
  });

  // --- assets ---------------------------------------------------------------

  app.get('/assets', async (c) => {
    const { list_assets } = tools().assets;
    const result = await list_assets.execute({}, makeHumanToolContext());
    return c.json(result);
  });

  app.post('/assets', async (c) => {
    const body = await safeJson<{ filename?: unknown; mimeType?: unknown; contentBase64?: unknown }>(c);
    if (
      typeof body.filename !== 'string' ||
      typeof body.mimeType !== 'string' ||
      typeof body.contentBase64 !== 'string'
    ) {
      return c.json({ error: 'filename, mimeType, and contentBase64 are required.' }, 400);
    }
    const { upload_asset } = tools().assets;
    const result = await upload_asset.execute(
      { filename: body.filename, mimeType: body.mimeType, contentBase64: body.contentBase64 },
      makeHumanToolContext(),
    );
    return c.json(result, 201);
  });

  app.delete('/assets/:id', async (c) => {
    const id = c.req.param('id');
    if (!UUID_PATTERN.test(id)) return c.json({ error: 'Not found' }, 404);
    const { delete_asset } = tools().assets;
    const result = (await delete_asset.execute({ id }, makeHumanToolContext())) as {
      deleted: boolean;
    };
    if (!result.deleted) return c.json({ error: 'Not found' }, 404);
    return c.json(result);
  });

  return app;
}

export const api = createApi();
