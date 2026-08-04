#!/usr/bin/env bun
/**
 * Live end-to-end scenario for the marketing-team example (task b7-verify).
 *
 * Runs the whole chain — lead routing, all five specialists, Postgres — against a real model
 * and a real database. Every assertion checks the DATABASE or the run TRACE (tool calls,
 * handoffs), never reply prose: the model's chat text is not a contract, only what it actually
 * wrote to Postgres and which tools it actually called are.
 *
 * Each step sends up to 3 turns on the same session before giving up: a live model does not
 * take the same path every time (see README "What the port taught us" — one run answered a
 * complete positioning brief by stuffing it into `save_user_preferences` instead of routing to
 * product-marketer). A nudge turn, playing the user confirming, resolves that without masking
 * an actual routing failure — the assertion is against the DATABASE after all turns, and against
 * the UNION of trace events across every turn in the step, not against any single turn.
 *
 * Usage: bun run scripts/e2e.ts   (needs OPENAI_API_KEY and DATABASE_URL in the environment)
 */
import { createRuntime, MemoryStore, MemoryTraceStore } from '@kuralle-agents/core';
import { selectModel } from '../agent/select-model.js';
import type { StreamPart } from '@kuralle-agents/core';
import { and, eq, desc } from 'drizzle-orm';
import { join } from 'node:path';
import { createLeadAgent } from '../agent/lead.js';
import { createSpecialistAgents } from '../agent/specialists.js';
import { db } from '../db/client.js';
import { markdownToTiptap } from '../db/content-format.js';
import { artifacts, brandContext, contentPieces, socialPosts, workspaces } from '../db/schema.js';

const STORAGE_ROOT = join(import.meta.dir, '..', 'storage');
const SURFACES = ['blog', 'x', 'linkedin', 'threads', 'bluesky', 'mastodon', 'email'] as const;
const NUDGE = 'Please go ahead now — everything you need was already in my last message.';

/**
 * Structural equality, ignoring object key order. `JSON.stringify` comparison isn't enough
 * here: Postgres jsonb does not preserve the key order a JS object literal was inserted with,
 * so a value read back can be byte-for-byte different from the one written even though nothing
 * about the document changed — verified live when `body_json` read back as
 * `{"text":...,"type":"text"}` for a node written as `{"type":"text","text":...}`.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  }
  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj).sort();
  const bKeys = Object.keys(bObj).sort();
  if (aKeys.length !== bKeys.length || aKeys.some((k, i) => k !== bKeys[i])) return false;
  return aKeys.every((k) => deepEqual(aObj[k], bObj[k]));
}

let checks = 0;
const findings: string[] = [];

function assert(condition: boolean, message: string): void {
  checks += 1;
  if (!condition) {
    console.error(`\n✗ FAIL (${checks}): ${message}`);
    process.exit(1);
  }
  console.log(`✓ (${checks}) ${message}`);
}

function note(message: string): void {
  findings.push(message);
  console.log(`  ⚠ ${message}`);
}


async function main(): Promise<void> {
  const model = selectModel();

  // --- 1. Seed a workspace ---------------------------------------------------------------
  const workspaceName = `E2E ${crypto.randomUUID()}`;
  const [workspace] = await db.insert(workspaces).values({ name: workspaceName }).returning();
  if (!workspace) throw new Error('failed to seed workspace');
  const workspaceId = workspace.id;
  console.log(`\nSeeded workspace ${workspaceId} (${workspaceName})\n`);

  const deps = {
    db,
    storageRoot: STORAGE_ROOT,
    surfaces: SURFACES,
    resolveScope: async () => ({ workspaceId, principalId: 'e2e-script' }),
    model,
  };

  const traceStore = new MemoryTraceStore();
  const lead = createLeadAgent(deps);
  const specialists = await createSpecialistAgents(deps);
  const runtime = createRuntime({
    agents: [lead, ...specialists],
    defaultAgentId: lead.id,
    sessionStore: new MemoryStore(),
    defaultModel: model,
    tracing: { enabled: true, store: traceStore },
  });

  async function runTurn(sessionId: string, input: string): Promise<StreamPart[]> {
    const handle = runtime.run({ sessionId, input });
    const parts: StreamPart[] = [];
    for await (const part of handle.events) parts.push(part);
    await handle;
    return parts;
  }

  function handoffTargets(parts: StreamPart[]): string[] {
    return parts
      .filter((p) => p.type === 'handoff')
      .map((p) => (p.payload as { targetAgent: string }).targetAgent);
  }

  function toolCalls(parts: StreamPart[]): Array<{ toolName: string; args: unknown }> {
    return parts
      .filter((p) => p.type === 'tool-call')
      .map((p) => p.payload as { toolName: string; args: unknown });
  }

  /**
   * Drives one session up to 3 turns (the opening brief, then up to 2 nudges), stopping the
   * moment `checkDb` returns a truthy result. Returns the DB result plus the UNION of trace
   * parts across every turn actually sent, so a caller can assert "X happened somewhere in
   * this step" without pinning it to whichever turn happened to do it.
   */
  async function runStep<T>(
    sessionId: string,
    brief: string,
    checkDb: () => Promise<T | undefined>,
  ): Promise<{ result: T | undefined; parts: StreamPart[] }> {
    const allParts: StreamPart[] = [];
    let result = await checkDb();
    let input = brief;
    for (let attempt = 0; attempt < 3 && !result; attempt += 1) {
      allParts.push(...(await runTurn(sessionId, input)));
      result = await checkDb();
      input = NUDGE;
    }
    return { result, parts: allParts };
  }

  // --- 2. Positioning work -> product-marketer -> writes brand context -------------------
  console.log('=== Step 2: positioning -> product-marketer ===');
  const positioningBrief =
    'We need to establish our brand positioning. We are Acme, a marketing-ops platform for ' +
    'small B2B SaaS teams (5-20 person marketing orgs, seed to Series B). Positioning: the ' +
    'fastest way for a small team to run marketing like a big one, without hiring a dedicated ' +
    'ops person. Differentiation: speed and simplicity versus enterprise suites like HubSpot ' +
    'Marketing Hub, which need a full-time admin to run. Voice: direct, concrete, no hype. ' +
    'Please write this up as our brand context and save it — I have already agreed to this ' +
    'exact wording, so go ahead and save it now.';

  const positioningStep = await runStep('e2e-positioning', positioningBrief, async () => {
    const [row] = await db.select().from(brandContext).where(eq(brandContext.workspaceId, workspaceId)).limit(1);
    return row;
  });
  assert(!!positioningStep.result, 'brand_context row exists for the workspace after the positioning ask');
  assert((positioningStep.result?.bodyMarkdown.length ?? 0) > 0, 'brand_context.body_markdown is non-empty');
  assert(
    handoffTargets(positioningStep.parts).includes('product-marketer'),
    'lead routed the positioning ask to product-marketer at some point in the step (trace: handoff part)',
  );

  // --- 3. Blog post -> content-marketer -> creates a content piece -----------------------
  console.log('\n=== Step 3: blog post -> content-marketer ===');
  const blogBrief =
    'Write a short blog post (3-4 short paragraphs) announcing that Acme now integrates with ' +
    'Slack, so status updates post straight to a channel. Everything you need is in this ' +
    'message — please draft it and save it now as a blog post.';

  const blogStep = await runStep('e2e-blog', blogBrief, async () => {
    const [row] = await db
      .select()
      .from(contentPieces)
      .where(and(eq(contentPieces.workspaceId, workspaceId), eq(contentPieces.kind, 'blog')))
      .orderBy(desc(contentPieces.createdAt))
      .limit(1);
    return row;
  });
  const blogPiece = blogStep.result;
  assert(!!blogPiece, 'a content_pieces row (kind=blog) exists for the workspace');
  assert(blogPiece?.authoredByAgent === 'content-marketer', 'the blog piece is authored_by_agent = content-marketer');
  assert(
    handoffTargets(blogStep.parts).includes('content-marketer'),
    'lead routed the blog-post ask to content-marketer at some point in the step (trace: handoff part)',
  );

  // --- 4. Read the piece back, assert body_json and body_markdown are populated AND consistent
  console.log('\n=== Step 4: read the blog piece back, verify body_json <-> body_markdown ===');
  assert((blogPiece?.bodyMarkdown.length ?? 0) > 0, 'blog piece body_markdown is non-empty');
  assert(!!blogPiece?.bodyJson && Object.keys(blogPiece.bodyJson as object).length > 0, 'blog piece body_json is non-empty');
  const rederivedJson = markdownToTiptap(blogPiece!.bodyMarkdown);
  assert(
    deepEqual(rederivedJson, blogPiece!.bodyJson),
    'body_json is structurally markdownToTiptap(body_markdown) — the two columns are consistent',
  );

  // --- 5. Newsletter: two-hop chain (content-marketer artifact -> email reads + adapts) ---
  // Structural note (see README "What the port taught us"): a handoff is a one-way, permanent
  // transfer of control — once routed, a session is pinned to that specialist for the rest of
  // the conversation. Specialists have no `routes`/`handoffs` of their own, so nothing can chain
  // a second hop within the SAME turn the way the lead's own instructions describe ("call the
  // first, wait, put its output in the second's brief"). That hand-off-the-artifact-id step is
  // therefore driven here exactly as a human operator (or the lead, across two separate asks)
  // would: two lead-addressed turns, glued by the artifact id read back from Postgres — never
  // from reply prose.
  console.log('\n=== Step 5: newsletter -> content-marketer artifact -> email reads it by id ===');
  const newsletterBrief =
    'We want to send our subscribers a newsletter about our new Slack integration: status ' +
    'updates from Acme now post straight into a Slack channel, so small marketing teams can ' +
    'follow progress without leaving Slack, and setup takes one click with no extra steps. ' +
    'This is a newsletter, not a blog post — draft the prose and save it as an artifact for ' +
    'email to adapt, the way you normally hand off a newsletter. Everything you need is in ' +
    'this message, so please go ahead now.';

  const newsletterDraftStep = await runStep('e2e-newsletter-draft', newsletterBrief, async () => {
    const [row] = await db
      .select()
      .from(artifacts)
      .where(and(eq(artifacts.workspaceId, workspaceId), eq(artifacts.createdByAgent, 'content-marketer')))
      .orderBy(desc(artifacts.createdAt))
      .limit(1);
    return row;
  });
  const newsletterArtifact = newsletterDraftStep.result;
  assert(!!newsletterArtifact, 'content-marketer saved an artifact (trace: DB row in artifacts)');
  assert(
    handoffTargets(newsletterDraftStep.parts).includes('content-marketer'),
    'lead routed the newsletter-prose ask to content-marketer at some point in the step (trace: handoff part)',
  );

  const emailBrief =
    `The content marketer already drafted our newsletter and saved it as artifact id ` +
    `"${newsletterArtifact!.id}". Read it with read_artifact and adapt it into a newsletter ` +
    'broadcast now — please create the email content piece. Everything you need is in this ' +
    'message, so go ahead now.';

  const emailStep = await runStep('e2e-newsletter-email', emailBrief, async () => {
    const [row] = await db
      .select()
      .from(contentPieces)
      .where(and(eq(contentPieces.workspaceId, workspaceId), eq(contentPieces.kind, 'email')))
      .orderBy(desc(contentPieces.createdAt))
      .limit(1);
    return row;
  });
  const emailPiece = emailStep.result;
  assert(!!emailPiece, 'a content_pieces row (kind=email) exists for the workspace');
  assert(emailPiece?.authoredByAgent === 'email', 'the email piece is authored_by_agent = email');
  assert(
    handoffTargets(emailStep.parts).includes('email'),
    'lead routed the newsletter-adaptation ask to email at some point in the step (trace: handoff part)',
  );
  const readArtifactCall = toolCalls(emailStep.parts).find(
    (c) => c.toolName === 'read_artifact' && (c.args as { id?: string })?.id === newsletterArtifact!.id,
  );
  assert(
    !!readArtifactCall,
    `email called read_artifact with the exact artifact id ${newsletterArtifact!.id} (trace: tool-call args)`,
  );

  // --- 6. Social posts -> social-media-coordinator ----------------------------------------
  console.log('\n=== Step 6: social posts -> social-media-coordinator ===');
  const socialBrief =
    'Draft two social posts announcing our new Slack integration — status updates from Acme ' +
    'now post straight into a Slack channel, one-click setup, no extra steps — one for X and ' +
    'one for LinkedIn. Everything you need is in this message — please draft and save both ' +
    'now as drafts.';

  const socialStep = await runStep('e2e-social', socialBrief, async () => {
    const rows = await db
      .select()
      .from(contentPieces)
      .where(and(eq(contentPieces.workspaceId, workspaceId), eq(contentPieces.kind, 'social')));
    return rows.length > 0 ? rows : undefined;
  });
  const socialPieces = socialStep.result ?? [];
  assert(socialPieces.length > 0, 'at least one content_pieces row (kind=social) exists for the workspace');
  assert(
    socialPieces.every((p) => p.authoredByAgent === 'social-media-coordinator'),
    'every social draft is authored_by_agent = social-media-coordinator',
  );
  assert(
    handoffTargets(socialStep.parts).includes('social-media-coordinator'),
    'lead routed the social-post ask to social-media-coordinator at some point in the step (trace: handoff part)',
  );

  const socialPostRows = await db.select().from(socialPosts).where(eq(socialPosts.workspaceId, workspaceId));
  if (socialPostRows.length === 0) {
    note(
      'social_posts stayed empty. The table is migrated and tenant-indexed (test/schema.db.test.ts ' +
        'asserts a workspace_id index on it) but no tool in agent/lib writes to it — ' +
        'social-media-coordinator only ever writes content_pieces (kind=social), and its own ' +
        'reviewed instructions.md says plainly that content-piece status "is the end of what ' +
        'this tool surface does." Brief b7-verify step 6 expected rows in social_posts; the ' +
        'schema and the shipped behavior disagree (workmanship rule 12). Not fixed here: wiring ' +
        'a new tool would change specialist behavior beyond what broke, and the current ' +
        'instructions were written and reviewed to match the content_pieces-only behavior. ' +
        'Flagging for a human decision rather than picking a side silently. The same is true of ' +
        'email_sends for the email specialist — also migrated, tenant-indexed, and never written.',
    );
  }

  // --- 7. SEO audit -> seo ----------------------------------------------------------------
  console.log('\n=== Step 7: SEO audit -> seo ===');
  const seoBrief =
    'Audit our homepage for organic search. Title tag: "Acme — Marketing Ops". Meta ' +
    'description: missing. H1: "Welcome to Acme". Body copy: three short paragraphs about the ' +
    'product with no target keyword mentioned. No internal links. This is everything I can ' +
    'give you right now, so please work from it rather than fetching the page yourself. Save ' +
    'the audit as an artifact and tell me the top finding.';

  const seoStep = await runStep('e2e-seo', seoBrief, async () => {
    const [row] = await db
      .select()
      .from(artifacts)
      .where(and(eq(artifacts.workspaceId, workspaceId), eq(artifacts.createdByAgent, 'seo')))
      .orderBy(desc(artifacts.createdAt))
      .limit(1);
    return row;
  });
  assert(!!seoStep.result, 'seo saved an audit artifact (trace: DB row in artifacts)');
  assert(
    handoffTargets(seoStep.parts).includes('seo'),
    'lead routed the SEO ask to seo at some point in the step (trace: handoff part)',
  );

  // --- Summary -----------------------------------------------------------------------------
  console.log(`\n${checks} assertions passed against workspace ${workspaceId}.`);
  const contentPiecesRows = await db.select().from(contentPieces).where(eq(contentPieces.workspaceId, workspaceId));
  const artifactsRows = await db.select().from(artifacts).where(eq(artifacts.workspaceId, workspaceId));
  console.log(
    JSON.stringify(
      {
        workspaceId,
        brandContextRows: 1,
        contentPiecesByKind: contentPiecesRows.reduce<Record<string, number>>((acc, row) => {
          acc[row.kind] = (acc[row.kind] ?? 0) + 1;
          return acc;
        }, {}),
        artifactsCount: artifactsRows.length,
        socialPostsCount: socialPostRows.length,
        findings,
      },
      null,
      2,
    ),
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('\ne2e scenario failed:', err);
    process.exit(1);
  });
