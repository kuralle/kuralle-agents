#!/usr/bin/env node
/**
 * Validates that the 0.7.2 prompt-cache wiring produces REAL cache hits.
 * Uses the shipped `applyPromptCache` helper + the live OpenAI API: a large
 * (>1024-token) stable system prefix + the same per-session promptCacheKey
 * across turns. Expect cachedInputTokens to jump from 0 (turn 1, cache write)
 * to >0 (turn 2+, cache read).
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { applyPromptCache } from '@kuralle-agents/core';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const KEY = (readFileSync(join(ROOT, '.env'), 'utf8').match(/^OPENAI_API_KEY=(.+)$/m)?.[1] || '')
  .trim().replace(/^["']|["']$/g, '');
if (!KEY) { console.error('OPENAI_API_KEY not found'); process.exit(1); }

const openai = createOpenAI({ apiKey: KEY });
const model = openai('gpt-4o-mini');

// Large STABLE system prefix (>1024 tokens) — the part OpenAI caches.
const BIG_SYSTEM =
  'You are a meticulous clinic front-desk assistant. Follow every policy exactly.\n' +
  Array.from({ length: 220 }, (_, i) =>
    `Policy ${i}: verify patient identity before disclosing any record; never reveal PHI ` +
    `without explicit verification; log access to chart ${i}; follow HIPAA minimum-necessary ` +
    `handling and escalate ambiguous consent for case ${i} to a supervisor.`,
  ).join('\n');

const sessionId = 'cache-validate-fixed-session';

async function turn(userText, n) {
  const messages = [{ role: 'user', content: userText }];
  const cached = applyPromptCache(model, sessionId, messages);
  const res = await generateText({
    model,
    system: BIG_SYSTEM,
    messages: cached.messages,
    ...(cached.providerOptions ? { providerOptions: cached.providerOptions } : {}),
  });
  const u = res.usage ?? {};
  const cachedTok = u.cachedInputTokens ?? u.promptTokensDetails?.cachedTokens ?? '?';
  console.log(
    `turn ${n}: inputTokens=${u.inputTokens ?? u.promptTokens ?? '?'}  cachedInputTokens=${cachedTok}` +
    `  promptCacheKey=${cached.providerOptions?.openai?.promptCacheKey ?? '(none)'}`,
  );
  if (n === 1) console.log(`  (raw usage: ${JSON.stringify(u)})`);
  return typeof cachedTok === 'number' ? cachedTok : 0;
}

console.log(`Validating OpenAI prompt-cache via shipped applyPromptCache | gpt-4o-mini | system ~${Math.round(BIG_SYSTEM.length / 4)} tokens\n`);
let anyHit = 0;
for (let i = 1; i <= 4; i += 1) anyHit = Math.max(anyHit, await turn(`Question ${i}: what are the clinic opening hours?`, i));
console.log(anyHit > 0
  ? `\n✅ CACHE HIT confirmed — up to ${anyHit} cached input tokens on a repeat turn.`
  : `\n⚠️ No cache hit observed (prefix may be under the 1024-token floor, or cache not yet warm).`);
