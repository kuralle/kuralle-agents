CREATE TYPE "public"."content_kind" AS ENUM('blog', 'landing', 'case-study', 'newsletter', 'docs', 'social', 'email');--> statement-breakpoint
CREATE TYPE "public"."content_status" AS ENUM('draft', 'in-review', 'approved', 'published');--> statement-breakpoint
CREATE TYPE "public"."email_send_status" AS ENUM('draft', 'queued', 'sent', 'failed');--> statement-breakpoint
CREATE TYPE "public"."social_post_status" AS ENUM('draft', 'queued', 'published', 'failed');--> statement-breakpoint
CREATE TYPE "public"."social_surface" AS ENUM('x', 'linkedin', 'threads', 'bluesky', 'mastodon');--> statement-breakpoint
CREATE TABLE "artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_by_agent" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"storage_path" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "brand_context" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"body_json" jsonb NOT NULL,
	"body_markdown" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaign_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"destination_url" text NOT NULL,
	"utm_source" text,
	"utm_medium" text,
	"utm_campaign" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content_pieces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" "content_kind" NOT NULL,
	"title" text NOT NULL,
	"slug" text NOT NULL,
	"status" "content_status" DEFAULT 'draft' NOT NULL,
	"body_json" jsonb NOT NULL,
	"body_markdown" text NOT NULL,
	"authored_by_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"content_piece_id" uuid NOT NULL,
	"body_json" jsonb NOT NULL,
	"body_markdown" text NOT NULL,
	"edited_by_agent" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_sends" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"content_piece_id" uuid NOT NULL,
	"subject" text NOT NULL,
	"preview_text" text,
	"recipients" jsonb NOT NULL,
	"status" "email_send_status" DEFAULT 'draft' NOT NULL,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "social_posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"content_piece_id" uuid NOT NULL,
	"surface" "social_surface" NOT NULL,
	"body" text NOT NULL,
	"scheduled_at" timestamp with time zone,
	"status" "social_post_status" DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"principal_id" text NOT NULL,
	"preferences" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_context" ADD CONSTRAINT "brand_context_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_links" ADD CONSTRAINT "campaign_links_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_pieces" ADD CONSTRAINT "content_pieces_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_revisions" ADD CONSTRAINT "content_revisions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_revisions" ADD CONSTRAINT "content_revisions_content_piece_id_content_pieces_id_fk" FOREIGN KEY ("content_piece_id") REFERENCES "public"."content_pieces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_sends" ADD CONSTRAINT "email_sends_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_sends" ADD CONSTRAINT "email_sends_content_piece_id_content_pieces_id_fk" FOREIGN KEY ("content_piece_id") REFERENCES "public"."content_pieces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_posts" ADD CONSTRAINT "social_posts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_posts" ADD CONSTRAINT "social_posts_content_piece_id_content_pieces_id_fk" FOREIGN KEY ("content_piece_id") REFERENCES "public"."content_pieces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "artifacts_workspace_id_idx" ON "artifacts" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "assets_workspace_id_idx" ON "assets" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "brand_context_workspace_id_key" ON "brand_context" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "campaign_links_workspace_id_idx" ON "campaign_links" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_links_workspace_id_slug_key" ON "campaign_links" USING btree ("workspace_id","slug");--> statement-breakpoint
CREATE INDEX "content_pieces_workspace_id_idx" ON "content_pieces" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "content_pieces_workspace_id_slug_key" ON "content_pieces" USING btree ("workspace_id","slug");--> statement-breakpoint
CREATE INDEX "content_revisions_workspace_id_idx" ON "content_revisions" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "content_revisions_content_piece_id_idx" ON "content_revisions" USING btree ("content_piece_id");--> statement-breakpoint
CREATE INDEX "email_sends_workspace_id_idx" ON "email_sends" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "email_sends_content_piece_id_idx" ON "email_sends" USING btree ("content_piece_id");--> statement-breakpoint
CREATE INDEX "social_posts_workspace_id_idx" ON "social_posts" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "social_posts_content_piece_id_idx" ON "social_posts" USING btree ("content_piece_id");--> statement-breakpoint
CREATE INDEX "user_preferences_workspace_id_idx" ON "user_preferences" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_preferences_workspace_id_principal_id_key" ON "user_preferences" USING btree ("workspace_id","principal_id");