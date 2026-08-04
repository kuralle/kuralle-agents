CREATE TABLE "brand_context_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"brand_context_id" uuid NOT NULL,
	"body_json" jsonb NOT NULL,
	"body_markdown" text NOT NULL,
	"edited_by_agent" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "brand_context_revisions" ADD CONSTRAINT "brand_context_revisions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_context_revisions" ADD CONSTRAINT "brand_context_revisions_brand_context_id_brand_context_id_fk" FOREIGN KEY ("brand_context_id") REFERENCES "public"."brand_context"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "brand_context_revisions_workspace_id_idx" ON "brand_context_revisions" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "brand_context_revisions_brand_context_id_idx" ON "brand_context_revisions" USING btree ("brand_context_id");