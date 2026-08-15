import {
  createRuntime,
  defineAgent,
  fsSkillStore,
  wrapAiSdkTool,
  type AgentConfig,
  type ChannelDriver,
} from '@kuralle-agents/core';
import type { LanguageModel } from 'ai';
import { createFsTool, InMemoryFs } from '@kuralle-agents/fs';
import {
  createMarkdownChunker,
  InMemoryVectorStore,
  RagPipeline,
  type Document,
  type Embedder,
} from '@kuralle-agents/rag';
import { createVectorRetrievalTool } from '@kuralle-agents/tools';

export const MODEL_ID = 'gpt-4.1-mini';
export const TASK = [
  'ACME-42 checkout errors rose immediately after a deploy.',
  'Before answering, do all four evidence steps:',
  '1. load the incident-response skill;',
  '2. read its references/escalation.md resource;',
  '3. read /accounts/ACME-42.md with the workspace tool;',
  '4. semantically search the knowledge base for the checkout recovery playbook.',
  'Then report the account region, incident severity, acknowledgement-time target, and playbook codename.',
].join(' ');

export const EXPECTED = {
  region: 'ap-south-1',
  severity: 'SEV-2',
  acknowledgement: '15 minutes',
  playbook: 'ORBIT-7',
} as const;

export const REQUIRED_TOOLS = [
  'load_skill',
  'read_skill_resource',
  'workspace',
  'semantic_search',
] as const;

const INCIDENT_SKILL = `---
name: incident-response
description: Classify and coordinate checkout incidents after a deployment. Load for checkout errors, elevated failures, or rollback decisions.
allowed-tools: [workspace, semantic_search]
---

# Incident response

- A checkout failure spike immediately following a deploy is **SEV-2** until impact is disproved.
- Inspect the affected account before recommending action.
- Retrieve the matching recovery playbook instead of guessing rollback steps.
- Read \`references/escalation.md\` before stating the paging target.
`;

const INITIAL_FILES = {
  '/accounts/ACME-42.md': [
    '# ACME-42',
    '',
    '- Region: ap-south-1',
    '- Plan: enterprise',
    '- Checkout path: edge-checkout-v3',
    '- Change window: active',
  ].join('\n'),
  '/accounts/BETA-9.md': '# BETA-9\n\n- Region: eu-west-1\n- Plan: standard',
  '/skills/incident-response/SKILL.md': INCIDENT_SKILL,
  '/skills/incident-response/references/escalation.md': [
    '# Escalation targets',
    '',
    'For a SEV-2 checkout incident, the on-call acknowledgement target is **15 minutes**.',
    'Page the commerce reliability rotation in #orbit-ops.',
  ].join('\n'),
} as const;

export const RAG_DOCUMENTS: Document[] = [
  {
    id: 'checkout-recovery',
    text: [
      '# Checkout Recovery Runbook',
      '',
      'The checkout recovery playbook codename is ORBIT-7.',
      'Use it for elevated checkout errors immediately after a deployment.',
      'Rollback the checkout feature flag, verify the payment queue drains, then compare error rate to the pre-deploy baseline.',
    ].join('\n'),
    metadata: { domain: 'checkout', kind: 'runbook' },
  },
  {
    id: 'catalog-recovery',
    text: [
      '# Catalog Recovery Runbook',
      '',
      'The catalog indexing recovery playbook is LATTICE-3.',
      'Use it for stale search results and delayed product indexing.',
    ].join('\n'),
    metadata: { domain: 'catalog', kind: 'runbook' },
  },
  {
    id: 'payments-audit',
    text: [
      '# Payments Audit Guide',
      '',
      'The monthly payment reconciliation procedure is LEDGER-5.',
      'It is not an incident rollback guide.',
    ].join('\n'),
    metadata: { domain: 'payments', kind: 'audit' },
  },
];

export interface ToolObservation {
  name: string;
  args: unknown;
  result?: unknown;
}

export interface ScenarioAssessment {
  passed: boolean;
  score: number;
  total: number;
  checks: Record<string, boolean>;
}

export class HashingEmbedder implements Embedder {
  readonly dimension = 96;
  readonly id = 'local:fnv1a-token-hash-v1';

  async embed(text: string): Promise<readonly number[]> {
    return this.vector(text);
  }

  async embedMany(texts: string[]): Promise<readonly (readonly number[])[]> {
    return texts.map((text) => this.vector(text));
  }

  private vector(text: string): readonly number[] {
    const vector = Array.from({ length: this.dimension }, () => 0);
    const tokens = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
    for (const token of tokens) {
      const hash = fnv1a(token);
      const index = hash % this.dimension;
      vector[index] += (hash & 0x100) === 0 ? 1 : -1;
    }
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    return norm === 0 ? vector : vector.map((value) => value / norm);
  }
}

function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export async function buildScenarioAgent(model: LanguageModel): Promise<{
  agent: AgentConfig;
  pipeline: RagPipeline;
  workspace: InMemoryFs;
}> {
  const workspace = new InMemoryFs(INITIAL_FILES);
  const pipeline = new RagPipeline({
    embedder: new HashingEmbedder(),
    vectorStore: new InMemoryVectorStore(),
    chunker: createMarkdownChunker(),
    indexName: 'operations-runbooks',
    topK: 2,
  });
  await pipeline.ingest(RAG_DOCUMENTS);

  const agent = defineAgent({
    id: 'full-stack-operations-agent',
    name: 'Full-stack Operations Agent',
    model,
    instructions: [
      'You are a concise evidence-first operations agent.',
      'For the benchmark incident, complete every evidence step requested by the user before emitting any prose.',
      'Use load_skill for incident-response, read_skill_resource for its escalation reference, workspace with op "cat" for the account file, and semantic_search for the recovery runbook.',
      'Do not substitute your own knowledge for a tool result.',
      'After all tools finish, answer in one sentence containing the region, severity, acknowledgement-time target, and playbook codename.',
    ].join(' '),
    workspace: { fs: workspace, readOnly: true },
    skills: fsSkillStore(workspace, ['/skills']),
    tools: {
      workspace: createFsTool({ fs: workspace, readOnly: true }),
      semantic_search: wrapAiSdkTool('semantic_search', createVectorRetrievalTool({
        retriever: pipeline,
        topK: 2,
        description: 'Search operational runbooks by meaning. Use this for incident recovery playbooks.',
      })),
    },
    limits: { maxSteps: 10, maxToolConcurrency: 4 },
  });

  return { agent, pipeline, workspace };
}

export function createScenarioRuntime(agent: AgentConfig, driver?: ChannelDriver) {
  return createRuntime({
    agents: [agent],
    defaultAgentId: agent.id,
    ...(driver ? { driver } : {}),
  });
}

export function assessScenario(
  answer: string,
  tools: ToolObservation[],
  errors: string[] = [],
): ScenarioAssessment {
  const normalized = answer.toLowerCase();
  const calls = tools.map((tool) => tool.name);
  const resultText = tools.map((tool) => stringify(tool.result)).join('\n').toLowerCase();
  const callText = tools.map((tool) => `${tool.name}:${stringify(tool.args)}`).join('\n').toLowerCase();
  const checks = {
    noErrors: errors.length === 0,
    emittedAnswer: answer.trim().length > 0,
    loadedIncidentSkill: calls.includes('load_skill') && callText.includes('incident-response'),
    readEscalationResource:
      calls.includes('read_skill_resource') && callText.includes('references/escalation.md'),
    readAccountFile: calls.includes('workspace') && callText.includes('/accounts/acme-42.md'),
    searchedRag: calls.includes('semantic_search'),
    fsEvidenceReturned: resultText.includes(EXPECTED.region),
    skillEvidenceReturned: resultText.includes(EXPECTED.severity.toLowerCase()),
    resourceEvidenceReturned: resultText.includes(EXPECTED.acknowledgement),
    ragEvidenceReturned: resultText.includes(EXPECTED.playbook.toLowerCase()),
    answerHasRegion: normalized.includes(EXPECTED.region),
    answerHasSeverity: normalized.includes(EXPECTED.severity.toLowerCase()),
    answerHasAcknowledgement: /\b15(?:\s+|-)(?:minute|minutes)\b/.test(normalized),
    answerHasPlaybook: normalized.includes(EXPECTED.playbook.toLowerCase()),
  };
  const score = Object.values(checks).filter(Boolean).length;
  const total = Object.keys(checks).length;
  return { passed: score === total, score, total, checks };
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
