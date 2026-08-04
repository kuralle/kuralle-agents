import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

// --- enums -----------------------------------------------------------------
// A typo in a status or kind is a bug the database should refuse, not store.

export const contentKind = pgEnum('content_kind', [
  'blog',
  'landing',
  'case-study',
  'newsletter',
  'docs',
  'social',
  'email',
]);

export const contentStatus = pgEnum('content_status', ['draft', 'in-review', 'approved', 'published']);

export const socialSurface = pgEnum('social_surface', [
  'x',
  'linkedin',
  'threads',
  'bluesky',
  'mastodon',
]);

export const socialPostStatus = pgEnum('social_post_status', [
  'draft',
  'queued',
  'published',
  'failed',
]);

export const emailSendStatus = pgEnum('email_send_status', [
  'draft',
  'queued',
  'sent',
  'failed',
]);

// --- shared column groups ---------------------------------------------------

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

// --- tables ------------------------------------------------------------------

export const workspaces = pgTable('workspaces', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  ...timestamps,
});

// One row per workspace: the shared positioning document the product marketer
// owns and the other four specialists read at the start of every task.
export const brandContext = pgTable(
  'brand_context',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    bodyJson: jsonb('body_json').notNull(),
    bodyMarkdown: text('body_markdown').notNull(),
    ...timestamps,
  },
  (table) => [
    // one brand context per workspace
    uniqueIndex('brand_context_workspace_id_key').on(table.workspaceId),
  ],
);

// The Notion replacement.
export const contentPieces = pgTable(
  'content_pieces',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    kind: contentKind('kind').notNull(),
    title: text('title').notNull(),
    slug: text('slug').notNull(),
    status: contentStatus('status').notNull().default('draft'),
    bodyJson: jsonb('body_json').notNull(),
    bodyMarkdown: text('body_markdown').notNull(),
    // Nullable on purpose: a piece a human wrote or rewrote in the editor has no authoring
    // agent. Forcing a value here would make the UI invent one, which corrupts the audit
    // trail this column exists to provide. NULL means "a person wrote this".
    authoredByAgent: text('authored_by_agent'),
    ...timestamps,
  },
  (table) => [
    index('content_pieces_workspace_id_idx').on(table.workspaceId),
    // slug is unique per workspace, not globally
    uniqueIndex('content_pieces_workspace_id_slug_key').on(table.workspaceId, table.slug),
  ],
);

// Append-only history keyed to content_pieces, so an editing pass is auditable.
export const contentRevisions = pgTable(
  'content_revisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    contentPieceId: uuid('content_piece_id')
      .notNull()
      .references(() => contentPieces.id),
    bodyJson: jsonb('body_json').notNull(),
    bodyMarkdown: text('body_markdown').notNull(),
    editedByAgent: text('edited_by_agent').notNull(),
    ...timestamps,
  },
  (table) => [
    index('content_revisions_workspace_id_idx').on(table.workspaceId),
    index('content_revisions_content_piece_id_idx').on(table.contentPieceId),
  ],
);

// Handoff payloads specialists pass to each other by id.
export const artifacts = pgTable(
  'artifacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    kind: text('kind').notNull(),
    payload: jsonb('payload').notNull(),
    createdByAgent: text('created_by_agent').notNull(),
    ...timestamps,
  },
  (table) => [index('artifacts_workspace_id_idx').on(table.workspaceId)],
);

// Uploaded files; bytes live on local disk under a gitignored storage/,
// metadata here.
export const assets = pgTable(
  'assets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    filename: text('filename').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    storagePath: text('storage_path').notNull(),
    ...timestamps,
  },
  (table) => [index('assets_workspace_id_idx').on(table.workspaceId)],
);

export const userPreferences = pgTable(
  'user_preferences',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    principalId: text('principal_id').notNull(),
    preferences: jsonb('preferences').notNull(),
    ...timestamps,
  },
  (table) => [
    index('user_preferences_workspace_id_idx').on(table.workspaceId),
    uniqueIndex('user_preferences_workspace_id_principal_id_key').on(
      table.workspaceId,
      table.principalId,
    ),
  ],
);

// The tracked-link vocabulary.
export const campaignLinks = pgTable(
  'campaign_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    slug: text('slug').notNull(),
    destinationUrl: text('destination_url').notNull(),
    utmSource: text('utm_source'),
    utmMedium: text('utm_medium'),
    utmCampaign: text('utm_campaign'),
    ...timestamps,
  },
  (table) => [
    index('campaign_links_workspace_id_idx').on(table.workspaceId),
    uniqueIndex('campaign_links_workspace_id_slug_key').on(table.workspaceId, table.slug),
  ],
);

// The Typefully replacement.
export const socialPosts = pgTable(
  'social_posts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    contentPieceId: uuid('content_piece_id')
      .notNull()
      .references(() => contentPieces.id),
    surface: socialSurface('surface').notNull(),
    body: text('body').notNull(),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }),
    status: socialPostStatus('status').notNull().default('draft'),
    ...timestamps,
  },
  (table) => [
    index('social_posts_workspace_id_idx').on(table.workspaceId),
    index('social_posts_content_piece_id_idx').on(table.contentPieceId),
  ],
);

// The Resend replacement.
export const emailSends = pgTable(
  'email_sends',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    contentPieceId: uuid('content_piece_id')
      .notNull()
      .references(() => contentPieces.id),
    subject: text('subject').notNull(),
    previewText: text('preview_text'),
    recipients: jsonb('recipients').notNull(),
    status: emailSendStatus('status').notNull().default('draft'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index('email_sends_workspace_id_idx').on(table.workspaceId),
    index('email_sends_content_piece_id_idx').on(table.contentPieceId),
  ],
);

// --- inferred types ------------------------------------------------------

export type Workspace = typeof workspaces.$inferSelect;
export type NewWorkspace = typeof workspaces.$inferInsert;

export type BrandContext = typeof brandContext.$inferSelect;
export type NewBrandContext = typeof brandContext.$inferInsert;

export type ContentPiece = typeof contentPieces.$inferSelect;
export type NewContentPiece = typeof contentPieces.$inferInsert;

export type ContentRevision = typeof contentRevisions.$inferSelect;
export type NewContentRevision = typeof contentRevisions.$inferInsert;

export type Artifact = typeof artifacts.$inferSelect;
export type NewArtifact = typeof artifacts.$inferInsert;

export type Asset = typeof assets.$inferSelect;
export type NewAsset = typeof assets.$inferInsert;

export type UserPreference = typeof userPreferences.$inferSelect;
export type NewUserPreference = typeof userPreferences.$inferInsert;

export type CampaignLink = typeof campaignLinks.$inferSelect;
export type NewCampaignLink = typeof campaignLinks.$inferInsert;

export type SocialPost = typeof socialPosts.$inferSelect;
export type NewSocialPost = typeof socialPosts.$inferInsert;

export type EmailSend = typeof emailSends.$inferSelect;
export type NewEmailSend = typeof emailSends.$inferInsert;
