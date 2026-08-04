import { defineTool } from '@kuralle-agents/core';
import { z } from 'zod';
import { campaignLinks } from '../../../db/schema.js';
import { resolveScope, type Db, type ResolveWorkspaceScope } from '../workspace-scope.js';

export interface TrackingToolsDeps {
  db: Db;
  resolveScope: ResolveWorkspaceScope;
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const slug = z.string().min(1).max(80).regex(SLUG, 'lowercase letters, numbers, and single hyphens only');

/** Builds (and records) a UTM-tagged link against the workspace's tracked-link vocabulary. */
export function createTrackingTools(deps: TrackingToolsDeps) {
  const { db, resolveScope: resolve } = deps;

  const build_tracked_link = defineTool({
    name: 'build_tracked_link',
    description: 'Create or update a tracked link (slug + UTM parameters) and return its full URL.',
    input: z.object({
      slug,
      destinationUrl: z.url(),
      utmSource: z.string().min(1).max(64).optional(),
      utmMedium: z.string().min(1).max(64).optional(),
      utmCampaign: z.string().min(1).max(64).optional(),
    }),
    execute: async ({ slug: s, destinationUrl, utmSource, utmMedium, utmCampaign }, ctx) => {
      const { workspaceId } = await resolveScope(resolve, ctx);
      const [saved] = await db
        .insert(campaignLinks)
        .values({ workspaceId, slug: s, destinationUrl, utmSource, utmMedium, utmCampaign })
        .onConflictDoUpdate({
          target: [campaignLinks.workspaceId, campaignLinks.slug],
          set: { destinationUrl, utmSource, utmMedium, utmCampaign, updatedAt: new Date() },
        })
        .returning();
      if (!saved) {
        throw new Error('build_tracked_link: upsert returned no row');
      }

      const url = new URL(saved.destinationUrl);
      if (saved.utmSource) url.searchParams.set('utm_source', saved.utmSource);
      if (saved.utmMedium) url.searchParams.set('utm_medium', saved.utmMedium);
      if (saved.utmCampaign) url.searchParams.set('utm_campaign', saved.utmCampaign);

      return { id: saved.id, slug: saved.slug, url: url.toString() };
    },
  });

  return { build_tracked_link };
}
