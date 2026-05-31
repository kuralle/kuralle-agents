/**
 * Scale Benchmark — tests cross-document retrieval quality as KB grows.
 *
 * Generates progressively larger knowledge bases (14 → 50 → 150 → 500 docs)
 * and measures whether cross-document queries still find all required topics.
 *
 * The hypothesis: with a small KB, direct retrieval accidentally finds cross-doc
 * results. With a large KB, topic dilution pushes secondary topics out of top-K,
 * making decomposition necessary.
 *
 * Usage: bun run scripts/bench-scale.ts
 */

import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, existsSync, mkdirSync, rmSync } from 'fs';
import { google } from '@ai-sdk/google';
import { generateObject } from 'ai';
import { z } from 'zod';
import {
  AiSdkEmbedder,
  BM25Index,
  FusionRetriever,
  MultiHopRetriever,
  InMemoryVectorStore,
  RagPipeline,
  createTokenChunker,
  type RetrievalResult,
  type Document,
} from '@kuralle-agents/rag';

const currentDir = dirname(fileURLToPath(import.meta.url));
const projectDir = join(currentDir, '..');

// ── Embedder ────────────────────────────────────────────────────────────────

const queryEmbedder = new AiSdkEmbedder({
  model: google.embedding('gemini-embedding-001'),
  providerOptions: { google: { taskType: 'RETRIEVAL_QUERY' } },
});

const docEmbedder = new AiSdkEmbedder({
  model: google.embedding('gemini-embedding-001'),
  providerOptions: { google: { taskType: 'RETRIEVAL_DOCUMENT' } },
});

const decomposerModel = google('gemini-2.0-flash');
const chunker = createTokenChunker({ defaults: { maxTokens: 256 } });

// ── Noise Document Generator ────────────────────────────────────────────────
// Generates realistic but irrelevant documents to dilute the KB.

const NOISE_CATEGORIES = [
  { category: 'hr', topics: [
    'Employee onboarding process for new hires in the engineering department',
    'Annual performance review guidelines and rating criteria',
    'Remote work policy and home office equipment allowance',
    'Parental leave benefits and return-to-work programs',
    'Company holiday calendar and floating holiday requests',
    'Health insurance plan comparison: PPO vs HMO vs HDHP',
    'Retirement savings plan 401k matching and vesting schedule',
    'Employee referral bonus program and eligibility requirements',
    'Diversity and inclusion training requirements and certification',
    'Workplace harassment reporting procedures and investigation timeline',
    'Sick leave accrual policy and medical documentation requirements',
    'Travel reimbursement policy and per diem rates by city',
    'Professional development budget allocation and approval process',
    'Employee stock option plan ESOP vesting and exercise windows',
    'Exit interview process and final paycheck timeline',
  ]},
  { category: 'engineering', topics: [
    'API rate limiting strategy using token bucket algorithm',
    'Database migration runbook for PostgreSQL 15 to 16 upgrade',
    'Kubernetes pod autoscaling configuration and HPA thresholds',
    'CI/CD pipeline architecture using GitHub Actions and ArgoCD',
    'Microservices communication patterns: gRPC vs REST vs GraphQL',
    'Redis caching strategy for session management at scale',
    'Load balancer configuration and health check endpoints',
    'Error monitoring setup with Sentry and PagerDuty integration',
    'Feature flag management using LaunchDarkly best practices',
    'Database sharding strategy for multi-tenant SaaS application',
    'Log aggregation pipeline using Fluentd and Elasticsearch',
    'SSL certificate rotation automation and monitoring alerts',
    'API versioning strategy and deprecation policy timeline',
    'Container image security scanning and vulnerability management',
    'Infrastructure as code with Terraform module organization',
  ]},
  { category: 'marketing', topics: [
    'Q3 content marketing calendar and social media posting schedule',
    'Brand voice guidelines and tone for customer communications',
    'SEO keyword strategy for product landing pages optimization',
    'Email marketing automation workflows for lead nurturing',
    'Competitive analysis report for enterprise SaaS market 2026',
    'Trade show booth design requirements and staffing schedule',
    'Press release template and media distribution channels',
    'Customer testimonial collection process and approval workflow',
    'Influencer partnership program and compensation tiers',
    'Website analytics KPI dashboard and monthly reporting template',
    'Product launch playbook with timeline and stakeholder RACI',
    'Webinar production checklist and post-event follow-up sequence',
    'Paid advertising budget allocation across Google Ads and LinkedIn',
    'Customer case study interview guide and publication process',
    'Brand photography guidelines and approved stock photo libraries',
  ]},
  { category: 'legal', topics: [
    'Terms of service version 3.2 updates and changelog summary',
    'Data processing agreement template for enterprise customers',
    'GDPR compliance checklist and data subject access request process',
    'SOC 2 Type II audit preparation timeline and evidence collection',
    'Intellectual property assignment agreement for contractors',
    'Non-disclosure agreement template and classification levels',
    'Cookie consent implementation requirements by jurisdiction',
    'Software license audit process and compliance verification',
    'Vendor security assessment questionnaire and scoring criteria',
    'Incident response plan and breach notification requirements',
    'Data retention schedule by category and jurisdictional requirements',
    'Export compliance screening for international customer onboarding',
    'Accessibility compliance WCAG 2.1 AA requirements checklist',
    'Insurance coverage summary: general liability and cyber insurance',
    'Arbitration clause and dispute resolution procedures',
  ]},
  { category: 'finance', topics: [
    'Monthly expense report submission deadline and approval workflow',
    'Purchase order process for vendor contracts over $10,000',
    'Revenue recognition policy for subscription and usage-based billing',
    'Budget planning template for departmental fiscal year allocation',
    'Invoice payment terms: net-30 vs net-60 by vendor category',
    'Corporate credit card policy and spending limits by role',
    'Quarterly financial reporting timeline and board presentation prep',
    'Accounts receivable aging report and collection escalation process',
    'Capital expenditure approval thresholds and ROI documentation',
    'Tax withholding and W-2 distribution timeline for employees',
  ]},
];

function generateNoiseDocs(count: number): Document[] {
  const docs: Document[] = [];
  let idx = 0;
  while (docs.length < count) {
    for (const cat of NOISE_CATEGORIES) {
      for (const topic of cat.topics) {
        if (docs.length >= count) break;
        docs.push({
          id: `noise-${cat.category}-${idx++}`,
          text: `## ${topic}\n\n${topic}. This is an internal document covering the details and procedures related to this topic. It includes step-by-step instructions, responsible parties, and escalation paths. Last updated Q1 2026. For questions, contact the ${cat.category} team.`,
          metadata: { source: 'noise', category: cat.category },
        });
      }
    }
  }
  return docs.slice(0, count);
}

// ── Core KB (always included) ───────────────────────────────────────────────

function loadCoreDocs(): Document[] {
  const knowledgeDir = join(projectDir, 'knowledge');
  const policies = readFileSync(join(knowledgeDir, 'policies.md'), 'utf-8');
  const products = readFileSync(join(knowledgeDir, 'products.md'), 'utf-8');

  const docs: Document[] = [];
  for (const section of policies.split(/^## /m).filter(Boolean)) {
    const title = section.split('\n')[0].trim();
    docs.push({
      id: `policy:${title.toLowerCase().replace(/\s+/g, '-')}`,
      text: `## ${section}`,
      metadata: { source: 'policies', category: 'policy' },
    });
  }
  for (const section of products.split(/^## /m).filter(Boolean)) {
    const title = section.split('\n')[0].trim();
    docs.push({
      id: `product:${title.toLowerCase().replace(/\s+/g, '-')}`,
      text: `## ${section}`,
      metadata: { source: 'products', category: 'product' },
    });
  }
  return docs;
}

// ── Test Queries ────────────────────────────────────────────────────────────

const testQueries = [
  {
    label: 'Cross-doc: Widget + refund',
    query: 'Can I return the Widget X100, and if so, how long will the refund take?',
    required: ['widget x100', 'refund', '30 days'],
  },
  {
    label: 'Cross-doc: Pro Plan + backup',
    query: 'Does the Pro Plan include cloud backup, and what does it cost?',
    required: ['pro', '$29', 'backup', '$4.99'],
  },
  {
    label: 'Cross-doc: warranty + Widget',
    query: 'What warranty does the Widget X100 come with and can I extend it?',
    required: ['warranty', '1-year', 'widget x100'],
  },
];

// ── Run ─────────────────────────────────────────────────────────────────────

function checkCoverage(results: RetrievalResult[], required: string[]): string[] {
  const allText = results.map(r => r.text).join(' ').toLowerCase();
  return required.filter(kw => !allText.includes(kw.toLowerCase()));
}

async function runScale(totalDocs: number, coreDocs: Document[]) {
  const noiseCount = Math.max(0, totalDocs - coreDocs.length);
  const noiseDocs = generateNoiseDocs(noiseCount);
  const allDocs = [...coreDocs, ...noiseDocs];

  // Fresh stores
  const vectorStore = new InMemoryVectorStore();
  const bm25 = new BM25Index();

  const pipeline = new RagPipeline({
    embedder: docEmbedder,
    vectorStore,
    chunker,
    indexName: 'scale-test',
    topK: 10,
  });

  console.log(`  Ingesting ${allDocs.length} documents (${coreDocs.length} core + ${noiseDocs.length} noise)...`);
  await pipeline.ingest(allDocs);

  const bm25Docs = allDocs.flatMap(doc => {
    const chunks = chunker.chunk(doc.text);
    return chunks.map(c => ({ id: `${doc.id}:${c.id}`, text: c.text, metadata: doc.metadata }));
  });
  bm25.add(bm25Docs);

  const fusion = new FusionRetriever({
    bm25, vectorStore, embedder: queryEmbedder,
    indexName: 'scale-test', bm25Weight: 0.3, topK: 5,
  });

  const decompose = async (q: string) => {
    const { object } = await generateObject({
      model: decomposerModel,
      schema: z.object({ queries: z.array(z.string()).min(1).max(3) }),
      system: 'Decompose into 1-3 independent search queries. Single-topic → 1 query.',
      prompt: q,
    });
    return object.queries;
  };

  const results: Array<{
    label: string;
    direct: { coverage: number; total: number; missing: string[]; topScore: number };
    gated: { coverage: number; total: number; missing: string[]; topScore: number; decomposed: boolean };
    always: { coverage: number; total: number; missing: string[]; topScore: number };
  }> = [];

  for (const tq of testQueries) {
    // Direct (no multi-hop at all)
    const directResults = await fusion.retrieve(tq.query);
    const directMissing = checkCoverage(directResults, tq.required);

    await new Promise(r => setTimeout(r, 500));

    // Quality-gated
    let gatedDecomposed = false;
    const gated = new MultiHopRetriever({
      retriever: fusion,
      decompose: async (q) => { gatedDecomposed = true; return decompose(q); },
      topK: 5, qualityThreshold: 0.5,
    });
    const gatedResults = await gated.retrieve(tq.query);
    const gatedMissing = checkCoverage(gatedResults, tq.required);

    await new Promise(r => setTimeout(r, 500));

    // Always decompose
    const alwaysRetriever = new MultiHopRetriever({
      retriever: fusion,
      decompose, topK: 5, qualityThreshold: 0,
    });
    const alwaysResults = await alwaysRetriever.retrieve(tq.query);
    const alwaysMissing = checkCoverage(alwaysResults, tq.required);

    results.push({
      label: tq.label,
      direct: {
        coverage: tq.required.length - directMissing.length,
        total: tq.required.length,
        missing: directMissing,
        topScore: directResults[0]?.score ?? 0,
      },
      gated: {
        coverage: tq.required.length - gatedMissing.length,
        total: tq.required.length,
        missing: gatedMissing,
        topScore: gatedResults[0]?.score ?? 0,
        decomposed: gatedDecomposed,
      },
      always: {
        coverage: tq.required.length - alwaysMissing.length,
        total: tq.required.length,
        missing: alwaysMissing,
        topScore: alwaysResults[0]?.score ?? 0,
      },
    });

    await new Promise(r => setTimeout(r, 1000));
  }

  return results;
}

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║  Scale Benchmark: Cross-Document Retrieval vs KB Size              ║');
  console.log('║  Does topic dilution break quality-gated decomposition?            ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝\n');

  const coreDocs = loadCoreDocs();
  console.log(`Core KB: ${coreDocs.length} documents (Acme Corp policies + products)\n`);

  const scales = [
    coreDocs.length,  // ~14 (baseline, no noise)
    50,
    150,
    500,
  ];

  const allResults: Array<{ scale: number; results: Awaited<ReturnType<typeof runScale>> }> = [];

  for (const scale of scales) {
    console.log(`\n${'═'.repeat(70)}`);
    console.log(`  KB SIZE: ${scale} documents`);
    console.log(`${'═'.repeat(70)}`);

    const results = await runScale(scale, coreDocs);
    allResults.push({ scale, results });

    for (const r of results) {
      const dCov = `${r.direct.coverage}/${r.direct.total}`;
      const gCov = `${r.gated.coverage}/${r.gated.total}`;
      const aCov = `${r.always.coverage}/${r.always.total}`;
      console.log(`\n  ${r.label}:`);
      console.log(`    Direct (no decompose): ${dCov} (top=${r.direct.topScore.toFixed(3)})${r.direct.missing.length ? ` MISSING: [${r.direct.missing.join(', ')}]` : ''}`);
      console.log(`    Quality-gated:         ${gCov} (top=${r.gated.topScore.toFixed(3)}, decomp=${r.gated.decomposed ? 'Y' : 'N'})${r.gated.missing.length ? ` MISSING: [${r.gated.missing.join(', ')}]` : ''}`);
      console.log(`    Always decompose:      ${aCov} (top=${r.always.topScore.toFixed(3)})${r.always.missing.length ? ` MISSING: [${r.always.missing.join(', ')}]` : ''}`);
    }
  }

  // ── Summary Matrix ────────────────────────────────────────────────────

  console.log(`\n${'═'.repeat(70)}`);
  console.log('  COVERAGE MATRIX (cross-document queries)');
  console.log(`${'═'.repeat(70)}\n`);

  const queryLabels = testQueries.map(q => q.label);

  console.log(`  ${'KB Size'.padEnd(10)} ${'Strategy'.padEnd(20)} ${queryLabels.map(l => l.slice(11, 30).padEnd(20)).join(' ')}`);
  console.log(`  ${'─'.repeat(10)} ${'─'.repeat(20)} ${queryLabels.map(() => '─'.repeat(20)).join(' ')}`);

  for (const { scale, results } of allResults) {
    const strategies = ['Direct', 'Quality-gated', 'Always decompose'];
    for (const strat of strategies) {
      const cells = results.map(r => {
        const data = strat === 'Direct' ? r.direct : strat === 'Quality-gated' ? r.gated : r.always;
        const cov = `${data.coverage}/${data.total}`;
        const flag = data.missing.length > 0 ? ' ⚠' : ' ✓';
        return (cov + flag).padEnd(20);
      });
      console.log(`  ${String(scale).padEnd(10)} ${strat.padEnd(20)} ${cells.join(' ')}`);
    }
    console.log();
  }
}

main().catch(console.error);
