#!/usr/bin/env bun
/**
 * Best-effort v1 → v2 authoring codemod for TypeScript example/agent files.
 *
 * Usage:
 *   bun packages/core/scripts/codemod-v2.ts <input.ts> [output.ts]
 *   bun packages/core/scripts/codemod-v2.ts --in-place path/to/file.ts
 *
 * Emits a hand-review list for expression/condition transitions it cannot convert.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const REVIEW: string[] = [];

function transform(source: string): string {
  let out = source;

  out = out.replace(/\btype:\s*['"](?:llm|flow|triage|composite)['"],?\n?/g, '');
  out = out.replace(/\b(LLMAgentConfig|FlowAgentConfig|TriageAgentConfig|CompositeAgentConfig)\b/g, 'AgentConfig');
  out = out.replace(/\bcanHandoffTo\b/g, 'handoffs');
  out = out.replace(/\bprompt\s*:/g, 'instructions:');
  out = out.replace(/\bnew Runtime\s*\(/g, 'createRuntime(');

  if (/\bflow\s*:\s*createFlow\s*\(/.test(out) && !/\bflows\s*:/.test(out)) {
    out = out.replace(/\bflow\s*:\s*(createFlow\([^)]+\))/g, 'flows: [$1]');
  }

  if (/\bFlowConfig\b/.test(out) || /\btransitions\s*:\s*\[/.test(out)) {
    REVIEW.push('FlowConfig/transitions[] detected — convert nodes to reply/collect/action/decide with returned transitions manually.');
  }
  if (/\b(expression|condition)\s*:/.test(out)) {
    REVIEW.push('expression/condition edge detected — rewrite as returned node refs in next/onComplete/decide handlers.');
  }
  if (/\bcreateFlowTransition\b/.test(out)) {
    REVIEW.push('createFlowTransition — move transition logic to reply.next() inspecting turn.toolResults.');
  }

  if (!out.includes('defineAgent') && out.includes('AgentConfig')) {
    out = `import { defineAgent } from '../../src/authoring/defineAgent.js';\n${out}`;
  }
  if (out.includes('createRuntime(') && !out.includes("from '../../src/runtime/Runtime.js'")) {
    out = `import { createRuntime } from '../../src/runtime/Runtime.js';\n${out}`;
  }

  return out;
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: codemod-v2.ts <input.ts> [output.ts] | --in-place <file.ts>');
    process.exit(1);
  }

  const inPlace = args[0] === '--in-place';
  const inputPath = inPlace ? args[1]! : args[0]!;
  const outputPath = inPlace ? inputPath : (args[1] ?? inputPath.replace(/\.ts$/, '.v2.ts'));

  const source = readFileSync(inputPath, 'utf8');
  const result = transform(source);
  writeFileSync(outputPath, result);

  console.log(`Wrote ${outputPath}`);
  if (REVIEW.length) {
    console.log('\nHand-review required:');
    for (const item of REVIEW) console.log(`  - ${item}`);
  } else {
    console.log('No automatic hand-review flags.');
  }
}

main();
