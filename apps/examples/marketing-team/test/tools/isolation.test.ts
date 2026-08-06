import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { createArtifactTools } from '../../agent/lib/artifacts/tools.js';
import { createAssetTools } from '../../agent/lib/assets/tools.js';
import { createBrandContextTools } from '../../agent/lib/brand-context/tools.js';
import { createContentTools } from '../../agent/lib/content/tools.js';
import { createTrackingTools } from '../../agent/lib/tracking/tools.js';
import { createUserPreferenceTools } from '../../agent/lib/user-preferences/tools.js';
import {
  artifacts,
  assets,
  brandContext,
  campaignLinks,
  contentPieces,
  userPreferences,
} from '../../db/schema.js';
import { connectDb, createWorkspace, makeCtx, mutableScope, suffix, withStorageRoot } from './helpers.js';

/**
 * The property every one of these tools depends on. Two workspaces (A and B): a tool called
 * under A's scope must never see or mutate a row that belongs to B, even when it is handed
 * B's row id directly, and even when B's row was written under a colliding natural key (the
 * same content slug, the same tracked-link slug, the same principal id).
 *
 * A suite that exercises only one workspace has nothing to leak to, so every case here sets
 * up rows in BOTH workspaces and asserts on both sides. Fixture rows are inserted directly
 * against the database, not through the tool under test's sibling tools — a bug that let a
 * write leak across tenants and a bug that let a read leak across tenants would otherwise be
 * able to cancel each other out and still look green.
 */

let db: NonNullable<Awaited<ReturnType<typeof connectDb>>>['db'];
let sqlClient: NonNullable<Awaited<ReturnType<typeof connectDb>>>['sqlClient'];
let reachable = false;

beforeAll(async () => {
  const conn = await connectDb();
  if (!conn) {
    console.warn('[marketing-team] Skipping isolation tests: database unreachable.');
    return;
  }
  db = conn.db;
  sqlClient = conn.sqlClient;
  reachable = true;
});

afterAll(async () => {
  await sqlClient?.end({ timeout: 5 });
});

const dbIt = (name: string, fn: () => Promise<void>) =>
  it(name, async () => {
    if (!reachable) return;
    await fn();
  });

describe('per-tool workspace isolation', () => {
  dbIt('get_brand_context cannot read another workspace’s document', async () => {
    const s = suffix();
    const a = await createWorkspace(db, `iso-bc-a-${s}`);
    const b = await createWorkspace(db, `iso-bc-b-${s}`);
    await db.insert(brandContext).values({ workspaceId: b.id, bodyMarkdown: 'B doc', bodyJson: {} });

    const { get_brand_context } = createBrandContextTools({ db, resolveScope: () => ({ workspaceId: a.id, principalId: 'p' }) });
    const result = (await get_brand_context.execute({}, makeCtx())) as { found: boolean };
    expect(result.found).toBe(false);
  });

  dbIt('save_brand_context cannot overwrite another workspace’s document', async () => {
    const s = suffix();
    const a = await createWorkspace(db, `iso-bc-save-a-${s}`);
    const b = await createWorkspace(db, `iso-bc-save-b-${s}`);
    await db.insert(brandContext).values({ workspaceId: b.id, bodyMarkdown: 'B original', bodyJson: {} });

    const { save_brand_context } = createBrandContextTools({ db, resolveScope: () => ({ workspaceId: a.id, principalId: 'p' }) });
    await save_brand_context.execute({ markdown: 'A content' }, makeCtx());

    const [bRow] = await db.select().from(brandContext).where(eq(brandContext.workspaceId, b.id));
    const [aRow] = await db.select().from(brandContext).where(eq(brandContext.workspaceId, a.id));
    expect(bRow!.bodyMarkdown).toBe('B original');
    expect(aRow!.bodyMarkdown).toBe('A content');
  });

  dbIt('save_artifact scopes the new row to the resolving workspace, not any other', async () => {
    const s = suffix();
    const a = await createWorkspace(db, `iso-art-save-a-${s}`);
    const b = await createWorkspace(db, `iso-art-save-b-${s}`);

    const { save_artifact } = createArtifactTools({ db, resolveScope: () => ({ workspaceId: a.id, principalId: 'p' }) });
    const { id } = (await save_artifact.execute({ kind: 'brief', payload: { x: 1 } }, makeCtx())) as { id: string };

    const [row] = await db.select().from(artifacts).where(eq(artifacts.id, id));
    expect(row!.workspaceId).toBe(a.id);
    expect(row!.workspaceId).not.toBe(b.id);
  });

  dbIt('read_artifact cannot read another workspace’s artifact by id', async () => {
    const s = suffix();
    const a = await createWorkspace(db, `iso-art-read-a-${s}`);
    const b = await createWorkspace(db, `iso-art-read-b-${s}`);
    const [bArtifact] = await db
      .insert(artifacts)
      .values({ workspaceId: b.id, kind: 'brief', payload: { secret: true }, createdByAgent: 'seed' })
      .returning();

    const { read_artifact } = createArtifactTools({ db, resolveScope: () => ({ workspaceId: a.id, principalId: 'p' }) });
    const result = (await read_artifact.execute({ id: bArtifact!.id }, makeCtx())) as { found: boolean };
    expect(result.found).toBe(false);
  });

  dbIt('upload_asset scopes the new row (and its bytes) to the resolving workspace', async () => {
    await withStorageRoot(async (storageRoot) => {
      const s = suffix();
      const a = await createWorkspace(db, `iso-asset-up-a-${s}`);
      const b = await createWorkspace(db, `iso-asset-up-b-${s}`);
      const { upload_asset } = createAssetTools({
        db,
        resolveScope: () => ({ workspaceId: a.id, principalId: 'p' }),
        storageRoot,
      });
      const { id } = (await upload_asset.execute(
        { filename: 'x.txt', mimeType: 'text/plain', contentBase64: Buffer.from('hi').toString('base64') },
        makeCtx(),
      )) as { id: string };

      const [row] = await db.select().from(assets).where(eq(assets.id, id));
      expect(row!.workspaceId).toBe(a.id);
      expect(row!.workspaceId).not.toBe(b.id);
      expect(row!.storagePath).toBe(join(storageRoot, a.id, id));
    });
  });

  dbIt('download_asset cannot read another workspace’s bytes by id', async () => {
    await withStorageRoot(async (storageRoot) => {
      const s = suffix();
      const a = await createWorkspace(db, `iso-asset-dl-a-${s}`);
      const b = await createWorkspace(db, `iso-asset-dl-b-${s}`);
      const bAssetId = crypto.randomUUID();
      await writeFile(join(storageRoot, `${bAssetId}-bytes`), 'b-secret');
      await db.insert(assets).values({
        id: bAssetId,
        workspaceId: b.id,
        filename: 'b.txt',
        mimeType: 'text/plain',
        sizeBytes: 8,
        storagePath: join(storageRoot, `${bAssetId}-bytes`),
      });

      const { download_asset } = createAssetTools({ db, resolveScope: () => ({ workspaceId: a.id, principalId: 'p' }), storageRoot });
      const result = (await download_asset.execute({ id: bAssetId }, makeCtx())) as { found: boolean };
      expect(result.found).toBe(false);
    });
  });

  dbIt('list_assets never includes another workspace’s assets', async () => {
    await withStorageRoot(async (storageRoot) => {
      const s = suffix();
      const a = await createWorkspace(db, `iso-asset-list-a-${s}`);
      const b = await createWorkspace(db, `iso-asset-list-b-${s}`);
      const aId = crypto.randomUUID();
      const bId = crypto.randomUUID();
      await db.insert(assets).values([
        { id: aId, workspaceId: a.id, filename: 'a.txt', mimeType: 'text/plain', sizeBytes: 1, storagePath: '/dev/null' },
        { id: bId, workspaceId: b.id, filename: 'b.txt', mimeType: 'text/plain', sizeBytes: 1, storagePath: '/dev/null' },
      ]);

      const { list_assets } = createAssetTools({ db, resolveScope: () => ({ workspaceId: a.id, principalId: 'p' }), storageRoot });
      const result = (await list_assets.execute({}, makeCtx())) as { assets: Array<{ id: string }> };
      const ids = result.assets.map((row) => row.id);
      expect(ids).toContain(aId);
      expect(ids).not.toContain(bId);
    });
  });

  dbIt('get_asset_info cannot read another workspace’s metadata by id', async () => {
    await withStorageRoot(async (storageRoot) => {
      const s = suffix();
      const a = await createWorkspace(db, `iso-asset-info-a-${s}`);
      const b = await createWorkspace(db, `iso-asset-info-b-${s}`);
      const bId = crypto.randomUUID();
      await db.insert(assets).values({
        id: bId, workspaceId: b.id, filename: 'b.txt', mimeType: 'text/plain', sizeBytes: 1, storagePath: '/dev/null',
      });

      const { get_asset_info } = createAssetTools({ db, resolveScope: () => ({ workspaceId: a.id, principalId: 'p' }), storageRoot });
      const result = (await get_asset_info.execute({ id: bId }, makeCtx())) as { found: boolean };
      expect(result.found).toBe(false);
    });
  });

  dbIt('delete_asset cannot delete another workspace’s asset by id', async () => {
    await withStorageRoot(async (storageRoot) => {
      const s = suffix();
      const a = await createWorkspace(db, `iso-asset-del-a-${s}`);
      const b = await createWorkspace(db, `iso-asset-del-b-${s}`);
      const bId = crypto.randomUUID();
      const bPath = join(storageRoot, `${bId}-bytes`);
      await writeFile(bPath, 'still here');
      await db.insert(assets).values({
        id: bId, workspaceId: b.id, filename: 'b.txt', mimeType: 'text/plain', sizeBytes: 10, storagePath: bPath,
      });

      const { delete_asset } = createAssetTools({ db, resolveScope: () => ({ workspaceId: a.id, principalId: 'p' }), storageRoot });
      const result = (await delete_asset.execute({ id: bId }, makeCtx())) as { deleted: boolean };
      expect(result.deleted).toBe(false);

      const [stillThere] = await db.select().from(assets).where(eq(assets.id, bId));
      expect(stillThere).toBeDefined();
      expect(await readFile(bPath, 'utf8')).toBe('still here');
    });
  });

  dbIt('create_content scopes the new piece to the resolving workspace, not any other', async () => {
    const s = suffix();
    const a = await createWorkspace(db, `iso-content-create-a-${s}`);
    const b = await createWorkspace(db, `iso-content-create-b-${s}`);
    const { create_content } = createContentTools({ db, resolveScope: () => ({ workspaceId: a.id, principalId: 'p' }) });
    const { id } = (await create_content.execute(
      { kind: 'blog', title: 'Title', slug: `slug-${s}`, markdown: 'Body copy here.' },
      makeCtx(),
    )) as { id: string };

    const [row] = await db.select().from(contentPieces).where(eq(contentPieces.id, id));
    expect(row!.workspaceId).toBe(a.id);
    expect(row!.workspaceId).not.toBe(b.id);
  });

  dbIt('update_content cannot mutate another workspace’s piece by id', async () => {
    const s = suffix();
    const a = await createWorkspace(db, `iso-content-upd-a-${s}`);
    const b = await createWorkspace(db, `iso-content-upd-b-${s}`);
    const [bPiece] = await db
      .insert(contentPieces)
      .values({ workspaceId: b.id, kind: 'blog', title: 'B', slug: `b-${s}`, bodyJson: {}, bodyMarkdown: 'original' })
      .returning();

    const { update_content } = createContentTools({ db, resolveScope: () => ({ workspaceId: a.id, principalId: 'p' }) });
    const result = (await update_content.execute({ id: bPiece!.id, markdown: 'hijacked' }, makeCtx())) as { found: boolean };
    expect(result.found).toBe(false);

    const [stillOriginal] = await db.select().from(contentPieces).where(eq(contentPieces.id, bPiece!.id));
    expect(stillOriginal!.bodyMarkdown).toBe('original');
  });

  dbIt('get_content cannot read another workspace’s piece by id', async () => {
    const s = suffix();
    const a = await createWorkspace(db, `iso-content-get-a-${s}`);
    const b = await createWorkspace(db, `iso-content-get-b-${s}`);
    const [bPiece] = await db
      .insert(contentPieces)
      .values({ workspaceId: b.id, kind: 'blog', title: 'B', slug: `b-${s}`, bodyJson: {}, bodyMarkdown: 'secret' })
      .returning();

    const { get_content } = createContentTools({ db, resolveScope: () => ({ workspaceId: a.id, principalId: 'p' }) });
    const result = (await get_content.execute({ id: bPiece!.id }, makeCtx())) as { found: boolean };
    expect(result.found).toBe(false);
  });

  dbIt('list_content never includes another workspace’s pieces', async () => {
    const s = suffix();
    const a = await createWorkspace(db, `iso-content-list-a-${s}`);
    const b = await createWorkspace(db, `iso-content-list-b-${s}`);
    const [aPiece] = await db
      .insert(contentPieces)
      .values({ workspaceId: a.id, kind: 'blog', title: 'A', slug: `same-${s}`, bodyJson: {}, bodyMarkdown: 'a' })
      .returning();
    await db
      .insert(contentPieces)
      .values({ workspaceId: b.id, kind: 'blog', title: 'B', slug: `same-${s}`, bodyJson: {}, bodyMarkdown: 'b' });

    const { list_content } = createContentTools({ db, resolveScope: () => ({ workspaceId: a.id, principalId: 'p' }) });
    const result = (await list_content.execute({}, makeCtx())) as { content: Array<{ id: string }> };
    const ids = result.content.map((row) => row.id);
    expect(ids).toContain(aPiece!.id);
    expect(ids.length).toBe(1);
  });

  dbIt('set_content_status cannot change another workspace’s piece by id', async () => {
    const s = suffix();
    const a = await createWorkspace(db, `iso-content-status-a-${s}`);
    const b = await createWorkspace(db, `iso-content-status-b-${s}`);
    const [bPiece] = await db
      .insert(contentPieces)
      .values({ workspaceId: b.id, kind: 'blog', title: 'B', slug: `b-${s}`, bodyJson: {}, bodyMarkdown: 'b', status: 'draft' })
      .returning();

    const { set_content_status } = createContentTools({ db, resolveScope: () => ({ workspaceId: a.id, principalId: 'p' }) });
    const result = (await set_content_status.execute({ id: bPiece!.id, status: 'published' }, makeCtx())) as { found: boolean };
    expect(result.found).toBe(false);

    const [stillDraft] = await db.select().from(contentPieces).where(eq(contentPieces.id, bPiece!.id));
    expect(stillDraft!.status).toBe('draft');
  });

  dbIt('build_tracked_link keeps a colliding slug independent per workspace', async () => {
    const s = suffix();
    const a = await createWorkspace(db, `iso-track-a-${s}`);
    const b = await createWorkspace(db, `iso-track-b-${s}`);
    const slug = `promo-${s}`;
    const scope = mutableScope({ workspaceId: a.id, principalId: 'p' });
    const { build_tracked_link } = createTrackingTools({ db, resolveScope: scope.resolveScope });

    await build_tracked_link.execute({ slug, destinationUrl: 'https://a.example.com' }, makeCtx());
    scope.as({ workspaceId: b.id, principalId: 'p' });
    await build_tracked_link.execute({ slug, destinationUrl: 'https://b.example.com' }, makeCtx());

    const rows = await db.select().from(campaignLinks).where(eq(campaignLinks.slug, slug));
    const aRow = rows.find((row) => row.workspaceId === a.id);
    const bRow = rows.find((row) => row.workspaceId === b.id);
    expect(aRow!.destinationUrl).toBe('https://a.example.com');
    expect(bRow!.destinationUrl).toBe('https://b.example.com');
  });

  dbIt('get_user_preferences cannot read another workspace’s row for the same principal', async () => {
    const s = suffix();
    const a = await createWorkspace(db, `iso-prefs-get-a-${s}`);
    const b = await createWorkspace(db, `iso-prefs-get-b-${s}`);
    await db.insert(userPreferences).values({ workspaceId: b.id, principalId: 'shared-principal', preferences: { tone: 'B' } });

    const { get_user_preferences } = createUserPreferenceTools({ db, resolveScope: () => ({ workspaceId: a.id, principalId: 'shared-principal' }) });
    const result = (await get_user_preferences.execute({}, makeCtx())) as { found: boolean };
    expect(result.found).toBe(false);
  });

  dbIt('save_user_preferences cannot overwrite another workspace’s row for the same principal', async () => {
    const s = suffix();
    const a = await createWorkspace(db, `iso-prefs-save-a-${s}`);
    const b = await createWorkspace(db, `iso-prefs-save-b-${s}`);
    await db.insert(userPreferences).values({ workspaceId: b.id, principalId: 'shared-principal', preferences: { tone: 'B' } });

    const { save_user_preferences } = createUserPreferenceTools({ db, resolveScope: () => ({ workspaceId: a.id, principalId: 'shared-principal' }) });
    await save_user_preferences.execute({ preferences: { tone: 'A' } }, makeCtx());

    const [bRow] = await db
      .select()
      .from(userPreferences)
      .where(and(eq(userPreferences.workspaceId, b.id), eq(userPreferences.principalId, 'shared-principal')));
    const [aRow] = await db
      .select()
      .from(userPreferences)
      .where(and(eq(userPreferences.workspaceId, a.id), eq(userPreferences.principalId, 'shared-principal')));
    expect(bRow!.preferences).toEqual({ tone: 'B' });
    expect(aRow!.preferences).toEqual({ tone: 'A' });
  });

  dbIt('clear_user_preferences cannot delete another workspace’s row for the same principal', async () => {
    const s = suffix();
    const a = await createWorkspace(db, `iso-prefs-clear-a-${s}`);
    const b = await createWorkspace(db, `iso-prefs-clear-b-${s}`);
    await db.insert(userPreferences).values({ workspaceId: b.id, principalId: 'shared-principal', preferences: { tone: 'B' } });

    const { clear_user_preferences } = createUserPreferenceTools({ db, resolveScope: () => ({ workspaceId: a.id, principalId: 'shared-principal' }) });
    const result = (await clear_user_preferences.execute({}, makeCtx())) as { cleared: boolean };
    expect(result.cleared).toBe(false);

    const [stillThere] = await db
      .select()
      .from(userPreferences)
      .where(and(eq(userPreferences.workspaceId, b.id), eq(userPreferences.principalId, 'shared-principal')));
    expect(stillThere).toBeDefined();
  });
});
