import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createMarketingTools } from '../../agent/lib/index.js';
import { fakeSkill, makeCtx, createWorkspace, connectDb, suffix, withStorageRoot } from './helpers.js';

/**
 * Kuralle rule: tools return data. `toolDeniedResult`/`toolErrorResult` are the one exception,
 * and this surface adds neither — nothing here should ever hand the model a conversational
 * `message` field to relay verbatim. Exercised end to end (every tool, once, on its golden
 * path) rather than by inspecting source text, so a future tool that returns `{ message: ... }`
 * fails this test instead of silently passing review.
 */

let db: NonNullable<Awaited<ReturnType<typeof connectDb>>>['db'];
let sqlClient: NonNullable<Awaited<ReturnType<typeof connectDb>>>['sqlClient'];
let reachable = false;

beforeAll(async () => {
  const conn = await connectDb();
  if (!conn) {
    console.warn('[marketing-team] Skipping no-message-field tests: database unreachable.');
    return;
  }
  db = conn.db;
  sqlClient = conn.sqlClient;
  reachable = true;
});

afterAll(async () => {
  await sqlClient?.end({ timeout: 5 });
});

describe('no tool returns a conversational message field', () => {
  it('holds across every tool’s golden path', async () => {
    if (!reachable) return;
    await withStorageRoot(async (storageRoot) => {
      const s = suffix();
      const workspace = await createWorkspace(db, `no-message-${s}`);
      const getSkill = fakeSkill({ 'references/banned-words.json': JSON.stringify(['delve']) });
      const tools = createMarketingTools({
        db,
        resolveScope: () => ({ workspaceId: workspace.id, principalId: 'principal-1' }),
        storageRoot,
        surfaces: ['blog'],
      });
      const ctx = makeCtx({ currentAgent: 'test-agent', getSkill });

      const createContentResult = (await tools.create_content!.execute(
        { kind: 'blog', title: 'T', slug: `slug-${s}`, markdown: 'Body copy.' },
        ctx,
      )) as { id: string };
      const saveArtifactResult = (await tools.save_artifact!.execute({ kind: 'brief', payload: {} }, ctx)) as {
        id: string;
      };
      const uploadAssetResult = (await tools.upload_asset!.execute(
        { filename: 'a.txt', mimeType: 'text/plain', contentBase64: Buffer.from('hi').toString('base64') },
        ctx,
      )) as { id: string };
      const contentId = createContentResult.id;
      const artifactId = saveArtifactResult.id;
      const assetId = uploadAssetResult.id;

      const invocations: Array<[string, unknown]> = [
        ['get_brand_context', await tools.get_brand_context!.execute({}, ctx)],
        ['save_brand_context', await tools.save_brand_context!.execute({ markdown: 'brand doc' }, ctx)],
        ['save_artifact', saveArtifactResult],
        ['read_artifact', await tools.read_artifact!.execute({ id: artifactId }, ctx)],
        ['upload_asset', uploadAssetResult],
        ['download_asset', await tools.download_asset!.execute({ id: assetId }, ctx)],
        ['list_assets', await tools.list_assets!.execute({}, ctx)],
        ['get_asset_info', await tools.get_asset_info!.execute({ id: assetId }, ctx)],
        ['create_content', createContentResult],
        ['update_content', await tools.update_content!.execute({ id: contentId, markdown: 'v2' }, ctx)],
        ['get_content', await tools.get_content!.execute({ id: contentId }, ctx)],
        ['list_content', await tools.list_content!.execute({}, ctx)],
        ['set_content_status', await tools.set_content_status!.execute({ id: contentId, status: 'in-review' }, ctx)],
        [
          'lint_against_style',
          await tools.lint_against_style!.execute({ surface: 'blog', text: 'We delve deep.' }, ctx),
        ],
        [
          'build_tracked_link',
          await tools.build_tracked_link!.execute(
            { slug: `promo-${s}`, destinationUrl: 'https://example.com' },
            ctx,
          ),
        ],
        ['save_user_preferences', await tools.save_user_preferences!.execute({ preferences: { tone: 'x' } }, ctx)],
        ['get_user_preferences', await tools.get_user_preferences!.execute({}, ctx)],
        // delete_asset and clear_user_preferences run last since they remove what the earlier
        // steps depend on.
        ['delete_asset', await tools.delete_asset!.execute({ id: assetId }, ctx)],
        ['clear_user_preferences', await tools.clear_user_preferences!.execute({}, ctx)],
      ];

      expect(invocations.length).toBe(Object.keys(tools).length);
      for (const [name, result] of invocations) {
        expect(result && typeof result === 'object', `${name} returned a non-object result`).toBe(true);
        expect(Object.prototype.hasOwnProperty.call(result, 'message'), `${name} returned a "message" field`).toBe(
          false,
        );
      }
    });
  });
});
