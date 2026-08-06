import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defineTool } from '@kuralle-agents/core';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { assets } from '../../../db/schema.js';
import { resolveScope, type Db, type ResolveWorkspaceScope } from '../workspace-scope.js';

export interface AssetToolsDeps {
  db: Db;
  resolveScope: ResolveWorkspaceScope;
  /** Root directory bytes are written under (gitignored `storage/` by default). */
  storageRoot: string;
}

const WORKSPACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ASSET_ID = WORKSPACE_ID;

// The Vercel Blob replacement: bytes on local disk, metadata in Postgres. The on-disk path is
// built ONLY from server-generated uuids (the resolved workspace id and a freshly minted
// asset id) — never from the caller-supplied filename, which is stored purely as a display
// label. That keeps a crafted filename (`../../etc/passwd`, an absolute path, ...) from ever
// reaching a filesystem call.
function assetPath(storageRoot: string, workspaceId: string, assetId: string): string {
  if (!WORKSPACE_ID.test(workspaceId) || !ASSET_ID.test(assetId)) {
    throw new Error('assetPath: expected uuid path segments');
  }
  return join(storageRoot, workspaceId, assetId);
}

export function createAssetTools(deps: AssetToolsDeps) {
  const { db, resolveScope: resolve, storageRoot } = deps;

  const upload_asset = defineTool({
    name: 'upload_asset',
    description: 'Upload an asset’s bytes (base64) and store its metadata.',
    input: z.object({
      filename: z.string().min(1).max(255),
      mimeType: z.string().min(1).max(255),
      contentBase64: z.string().min(1),
    }),
    execute: async ({ filename, mimeType, contentBase64 }, ctx) => {
      const { workspaceId } = await resolveScope(resolve, ctx);
      const bytes = Buffer.from(contentBase64, 'base64');
      const id = randomUUID();
      const path = assetPath(storageRoot, workspaceId, id);
      await mkdir(join(storageRoot, workspaceId), { recursive: true });
      await writeFile(path, bytes);
      try {
        const [saved] = await db
          .insert(assets)
          .values({
            id,
            workspaceId,
            filename,
            mimeType,
            sizeBytes: bytes.byteLength,
            storagePath: path,
          })
          .returning();
        if (!saved) {
          throw new Error('upload_asset: insert returned no row');
        }
        return { id: saved.id, filename: saved.filename, mimeType: saved.mimeType, sizeBytes: saved.sizeBytes };
      } catch (error) {
        await rm(path, { force: true });
        throw error;
      }
    },
  });

  const download_asset = defineTool({
    name: 'download_asset',
    description: 'Download an asset’s bytes (base64) and metadata by id.',
    input: z.object({ id: z.uuid() }),
    execute: async ({ id }, ctx) => {
      const { workspaceId } = await resolveScope(resolve, ctx);
      const row = await getOwnedAsset(db, id, workspaceId);
      if (!row) {
        return { found: false as const };
      }
      const bytes = await readFile(row.storagePath);
      return {
        found: true as const,
        id: row.id,
        filename: row.filename,
        mimeType: row.mimeType,
        sizeBytes: row.sizeBytes,
        contentBase64: bytes.toString('base64'),
      };
    },
  });

  const list_assets = defineTool({
    name: 'list_assets',
    description: 'List asset metadata for the workspace.',
    input: z.object({}),
    execute: async (_input, ctx) => {
      const { workspaceId } = await resolveScope(resolve, ctx);
      const rows = await db.select().from(assets).where(eq(assets.workspaceId, workspaceId));
      return {
        assets: rows.map((row) => ({
          id: row.id,
          filename: row.filename,
          mimeType: row.mimeType,
          sizeBytes: row.sizeBytes,
        })),
      };
    },
  });

  const get_asset_info = defineTool({
    name: 'get_asset_info',
    description: 'Read an asset’s metadata (no bytes) by id.',
    input: z.object({ id: z.uuid() }),
    execute: async ({ id }, ctx) => {
      const { workspaceId } = await resolveScope(resolve, ctx);
      const row = await getOwnedAsset(db, id, workspaceId);
      if (!row) {
        return { found: false as const };
      }
      return {
        found: true as const,
        id: row.id,
        filename: row.filename,
        mimeType: row.mimeType,
        sizeBytes: row.sizeBytes,
      };
    },
  });

  const delete_asset = defineTool({
    name: 'delete_asset',
    description: 'Permanently delete an asset’s bytes and metadata by id.',
    input: z.object({ id: z.uuid() }),
    execute: async ({ id }, ctx) => {
      const { workspaceId } = await resolveScope(resolve, ctx);
      const row = await getOwnedAsset(db, id, workspaceId);
      if (!row) {
        return { deleted: false as const };
      }
      await db.delete(assets).where(and(eq(assets.id, id), eq(assets.workspaceId, workspaceId)));
      await rm(row.storagePath, { force: true });
      return { deleted: true as const };
    },
  });

  return { upload_asset, download_asset, list_assets, get_asset_info, delete_asset };
}

async function getOwnedAsset(db: Db, id: string, workspaceId: string) {
  const [row] = await db
    .select()
    .from(assets)
    .where(and(eq(assets.id, id), eq(assets.workspaceId, workspaceId)))
    .limit(1);
  return row;
}
