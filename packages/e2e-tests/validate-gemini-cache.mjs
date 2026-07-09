#!/usr/bin/env node
/**
 * Validates Gemini IMPLICIT caching (default-on for 2.5+, parameter-free) at the
 * PROVIDER level via the Google REST API — the behavior is the provider's, so
 * this is independent of the AI SDK. kuralle wires NO Gemini cache option
 * (confirmed: applyPromptCache has no Google branch), because implicit caching
 * needs none. A large (>2048-token) stable prefix sent repeatedly should report
 * usageMetadata.cachedContentTokenCount > 0 on repeat turns.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const KEY = (readFileSync(join(ROOT, '.env'), 'utf8').match(/^GOOGLE_GENERATIVE_AI_API_KEY=(.+)$/m)?.[1] || '')
  .trim().replace(/^["']|["']$/g, '');
if (!KEY) { console.error('GOOGLE_GENERATIVE_AI_API_KEY not found'); process.exit(1); }

const MODEL = 'gemini-2.5-flash';
const URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${KEY}`;

const BIG_SYSTEM =
  'You are a meticulous clinic front-desk assistant. Follow every policy exactly.\n' +
  Array.from({ length: 220 }, (_, i) =>
    `Policy ${i}: verify patient identity before disclosing any record; never reveal PHI ` +
    `without explicit verification; log access to chart ${i}; follow HIPAA minimum-necessary ` +
    `handling and escalate ambiguous consent for case ${i} to a supervisor.`,
  ).join('\n');

async function turn(userText, n) {
  const res = await fetch(URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: BIG_SYSTEM }] },
      contents: [{ role: 'user', parts: [{ text: userText }] }],
    }),
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  const json = await res.json();
  const m = json.usageMetadata ?? {};
  const cached = m.cachedContentTokenCount ?? 0;
  console.log(`turn ${n}: promptTokens=${m.promptTokenCount ?? '?'}  cachedContentTokenCount=${cached}`);
  if (n === 1) console.log(`  (raw usageMetadata: ${JSON.stringify(m)})`);
  return cached;
}

console.log(`Gemini implicit-cache validation (REST) | ${MODEL} | system ~${Math.round(BIG_SYSTEM.length / 4)} tokens (>2048 floor)\n`);
let hit = 0;
for (let i = 1; i <= 4; i += 1) hit = Math.max(hit, await turn(`Question ${i}: what are the clinic opening hours?`, i));
console.log(hit > 0
  ? `\n✅ Gemini IMPLICIT cache HIT — up to ${hit} cached tokens, automatic, zero kuralle wiring.`
  : `\n⚠️ No implicit hit (under the 2048-token floor or cache not warm — implicit is best-effort, not guaranteed).`);
