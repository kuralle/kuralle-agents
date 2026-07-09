#!/usr/bin/env bun
/**
 * Live: a kuralle agent consumes an Open Knowledge Format (OKF v0.1) bundle
 * mounted on its workspace filesystem — no adapter, the `workspace` tool IS the
 * OKF consumption agent. A "okf-navigator" SKILL teaches the traversal procedure
 * (progressive disclosure: /index.md -> concept -> bundle-relative links). The
 * agent answers a real data question by navigating the bundle.
 *
 * Run:  KURALLE_EXAMPLE_PROVIDER=openai bun run packages/fs/examples/okf-knowledge-agent.ts
 * Spec: https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf
 */
import { createRuntime, defineAgent, createFsTool } from '@kuralle-agents/core';
import type { HarnessStreamPart, TurnHandle } from '@kuralle-agents/core';
import { okfBundleToFs, fsSkillStore } from '@kuralle-agents/fs';
import { SALES_BUNDLE, EXPECTED } from './_okf-bundle.js';

const NAVIGATOR_SKILL = `---
name: okf-navigator
description: How to answer a question from an Open Knowledge Format (OKF) bundle mounted on the workspace.
---

# OKF navigation procedure

The workspace holds an OKF v0.1 knowledge bundle — markdown concept files with
YAML frontmatter that cross-link into a graph.

TOOL: read bundle files ONLY with the \`workspace\` tool, e.g.
\`workspace({ op: 'read', path: '/index.md' })\`. Do NOT use \`read_skill_resource\`
— that reads a skill's own files, not the workspace bundle.

Procedure:
1. \`workspace({ op: 'read', path: '/index.md' })\` — progressive disclosure, lists concepts.
2. \`workspace({ op: 'read', path })\` on the concept whose description matches the question.
3. Follow bundle-relative links (e.g. \`/metrics/weekly_active_users.md\`, \`/tables/events.md\`)
   by reading them too — the \`# Definition\`, \`# Schema\`, \`# Joins\` sections hold the facts.
4. Answer using only what the bundle says. Name the exact table(s), the identity/join
   column, and the metric definition. Do not invent columns.
`;

async function resolveModel() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY required.');
  const { createOpenAI } = await import('@ai-sdk/openai');
  const modelId = process.env.OPENAI_MODEL ?? 'gpt-4o-mini';
  return { model: createOpenAI({ apiKey: key })(modelId), label: `openai:${modelId}` };
}

async function collect(handle: TurnHandle) {
  const parts: HarnessStreamPart[] = [];
  let text = '';
  for await (const part of handle.events) {
    parts.push(part);
    if (part.type === 'text-delta') text += part.delta;
  }
  const result = await handle;
  return { parts, text: text || result.text };
}

async function main() {
  const { model, label } = await resolveModel();
  console.log(`model: ${label}\n`);

  // The OKF bundle mounts directly on the workspace fs. Skills live alongside it.
  const fs = okfBundleToFs({ ...SALES_BUNDLE, '/skills/okf-navigator/SKILL.md': NAVIGATOR_SKILL });

  const agent = defineAgent({
    id: 'okf-analyst',
    model,
    instructions:
      'You are a data analyst. The workspace holds an OKF knowledge bundle. ' +
      'First call load_skill("okf-navigator") and follow it. Read bundle files with the ' +
      'workspace tool ({ op: "read", path }); read_skill_resource does NOT read the bundle. ' +
      'Ground every claim in files you have actually read.',
    tools: { workspace: createFsTool({ fs, readOnly: true }) },
    skills: fsSkillStore(fs),
    limits: { maxSteps: 10 }, // deep navigation: load_skill + several reads + answer
  });

  const runtime = createRuntime({ agents: [agent], defaultAgentId: 'okf-analyst' });
  const { parts, text } = await collect(
    runtime.run({
      input: 'How do I compute weekly active users from our data? Which table and which column is the join/identity key?',
      sessionId: 'okf-1',
    }),
  );

  const toolCalls = (parts.filter((p) => p.type === 'tool-call') as Array<{ toolName: string; args: unknown }>);
  const reads = toolCalls.filter((c) => c.toolName === 'workspace').map((c) => (c.args as { op?: string; path?: string }));
  console.log('--- skill loaded:', toolCalls.some((c) => c.toolName === 'load_skill'));
  console.log('--- workspace ops:', reads.map((r) => `${r.op}:${r.path ?? ''}`).join(', '));
  console.log('--- answer:', text.replace(/\s+/g, ' ').trim(), '\n');

  const t = text.toLowerCase();
  const failures: string[] = [];
  if (!toolCalls.some((c) => c.toolName === 'load_skill')) failures.push('did not load the okf-navigator skill');
  if (!reads.length) failures.push('did not navigate the bundle via the workspace tool');
  if (!t.includes(EXPECTED.table)) failures.push(`answer did not name the ${EXPECTED.table} table`);
  if (!t.includes(EXPECTED.joinKey)) failures.push(`answer did not name the ${EXPECTED.joinKey} key`);
  if (!t.includes(EXPECTED.metric)) failures.push('answer did not state the distinct-count definition');

  if (failures.length) {
    console.error('OKF SMOKE FAILED:\n' + failures.map((f) => `  - ${f}`).join('\n'));
    process.exit(1);
  }
  console.log('OKF SMOKE PASSED — agent loaded the navigator skill, traversed the OKF bundle, answered correctly.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
