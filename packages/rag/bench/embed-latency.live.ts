/**
 * Live query-embedding latency probe (the per-turn retrieval tax).
 *
 * Measures sequential single-query embeds against the OpenAI embeddings API
 * (the path the old vectorize-store README recommended from a Worker).
 * Requires OPENAI_API_KEY. The Workers AI comparison (env.AI binding,
 * in-network) can only be measured from inside a deployed Worker — run this
 * file's logic there to capture that side.
 */
import { percentile } from './lib.js';

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error('OPENAI_API_KEY not set');
  process.exit(1);
}

const QUERIES = [
  'what is the refund policy',
  'how long does shipping take',
  'is there a warranty on devices',
  'how do I cancel my subscription',
  'do you deliver internationally',
  'what payment methods are accepted',
  'how do I track my order',
  'can I exchange a damaged item',
  'what is the loyalty program',
  'how do I upgrade my plan',
  'when does my voucher expire',
  'how do I reach a support agent',
  'what is the return window',
  'are there express delivery options',
  'how are refunds processed',
  'what does the setup manual cover',
];

const latencies: number[] = [];
for (const q of QUERIES) {
  const t0 = performance.now();
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: 'text-embedding-3-small', input: q }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
  await res.json();
  latencies.push(performance.now() - t0);
}

const sorted = latencies.map((l) => Math.round(l));
console.log(
  JSON.stringify(
    {
      model: 'text-embedding-3-small',
      samples: latencies.length,
      p50Ms: Math.round(percentile(latencies, 50)),
      p95Ms: Math.round(percentile(latencies, 95)),
      meanMs: Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length),
      latenciesMs: sorted,
    },
    null,
    2,
  ),
);
