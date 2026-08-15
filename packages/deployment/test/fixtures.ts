import { createArtifact } from '../src/index.js';
import type { AgentArtifact, ArtifactInputV1, InlineFlowEntry } from '../src/index.js';

const INSTRUCTION_DIGEST = '67a17a57b438ad99d562505d18cf46ab5350b2008bab59087bf66bfb679399ab';

export function refundFlowDefinition(overrides: { description?: string } = {}) {
  return {
    name: 'refund',
    description: overrides.description ?? 'Start a refund.',
    start: 'say',
    nodes: [
      {
        kind: 'reply' as const,
        id: 'say',
        response: { template: 'Refund started' },
        next: { end: 'done' },
      },
    ],
  };
}

export function inlineRefundFlow(overrides: { description?: string } = {}): InlineFlowEntry {
  const definition = refundFlowDefinition(overrides);
  return { kind: 'inline', id: definition.name, definition };
}

export function artifactInput(overrides: Partial<ArtifactInputV1> = {}): ArtifactInputV1 {
  return {
    schemaVersion: 1,
    artifactId: 'support-artifact',
    compiler: { name: 'kuralle', version: '0.19.0' },
    runtimeApiRange: '^1.0.0',
    agent: {
      id: 'support',
      name: 'Support',
      model: 'openai/gpt-5-mini',
      limits: { maxTurns: 12, maxSteps: 20 },
      handoffs: [],
    },
    instructions: [{
      path: 'instructions.md',
      digest: INSTRUCTION_DIGEST,
      bytes: 18,
      mediaType: 'text/markdown',
      role: 'instructions',
      content: { kind: 'inline', text: 'You are concise.\n\n' },
    }],
    skills: [],
    references: [],
    workspaceSeed: [],
    agents: [],
    tools: [],
    flows: [],
    policies: {},
    requiredCapabilities: [],
    secretRefs: [],
    sourceMap: [],
    ...overrides,
  };
}

export async function artifact(overrides: Partial<ArtifactInputV1> = {}): Promise<AgentArtifact> {
  return createArtifact(artifactInput(overrides));
}
