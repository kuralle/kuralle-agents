#!/usr/bin/env node
/**
 * Drives a scripted multi-turn conversation against the deployed worker in both
 * grounding modes and reports, per turn: TTFT (time to first text token),
 * total turn latency, and how many `knowledge-search` retrievals fired.
 *
 *   BASE=https://kuralle-latency-ab.<subdomain>.workers.dev node measure.mjs
 */
const BASE = (process.env.BASE || process.argv[2] || '').replace(/\/$/, '');
if (!BASE) {
  console.error('Set BASE=<worker url>  (e.g. https://kuralle-latency-ab.<acct>.workers.dev)');
  process.exit(1);
}
const REPS = Number(process.env.REPS || 3);

// Mixed script: FAQ turns (answer) + intent turns (route into a flow).
const SCRIPT = [
  { kind: 'answer', text: 'What are your opening hours?' },
  { kind: 'answer', text: 'Do you have parking?' },
  { kind: 'route',  text: 'I want to book an appointment.' },
  { kind: 'answer', text: 'What insurance plans do you accept?' },
  { kind: 'route',  text: 'I need to file a complaint.' },
];

async function runTurn(mode, sessionId, message) {
  const t0 = performance.now();
  const res = await fetch(`${BASE}/run/${mode}/${sessionId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message }),
  });
  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status}: ${await res.text().catch(() => '')}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let ttft = null;
  let retrievals = 0;
  let firstError = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 2);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      let ev;
      try { ev = JSON.parse(payload); } catch { continue; }
      if (ev.type === 'knowledge-search') retrievals += 1;
      if ((ev.type === 'text-delta' || ev.type === 'text-start') && ttft === null) {
        ttft = performance.now() - t0;
      }
      if (ev.type === 'error' && !firstError) firstError = ev.error;
    }
  }
  return { ttft, total: performance.now() - t0, retrievals, error: firstError };
}

async function measureMode(mode) {
  const perTurn = SCRIPT.map(() => ({ ttft: [], total: [], retr: [], errors: 0 }));
  for (let r = 0; r < REPS; r += 1) {
    const sessionId = `${mode}-${r}-${Math.floor(Math.random() * 1e9)}`;
    for (let i = 0; i < SCRIPT.length; i += 1) {
      const out = await runTurn(mode, sessionId, SCRIPT[i].text);
      if (out.error) perTurn[i].errors += 1;
      if (out.ttft != null) perTurn[i].ttft.push(out.ttft);
      perTurn[i].total.push(out.total);
      perTurn[i].retr.push(out.retrievals);
    }
  }
  return perTurn;
}

const med = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const fmt = (x) => (x == null ? '  —  ' : `${Math.round(x)}`.padStart(5));

async function main() {
  console.log(`Worker: ${BASE}  |  reps: ${REPS}  |  model: gpt-4o-mini  |  retriever: text-embedding-3-small\n`);
  // Warm both DO classes (cold start / doc-embedding cache) before timing.
  await runTurn('guaranteed', `warm-${Date.now()}`, 'hello').catch(() => {});
  await runTurn('on-demand', `warm-${Date.now()}`, 'hello').catch(() => {});

  const guaranteed = await measureMode('guaranteed');
  const onDemand = await measureMode('on-demand');

  console.log('Per-turn median TTFT (ms) and retrieval count (#ret = knowledge-search events):\n');
  console.log('  #  kind     | guaranteed TTFT  #ret | on-demand TTFT  #ret |  TTFT Δ (on-demand − guaranteed)');
  console.log('  ---------------------------------------------------------------------------------------------');
  SCRIPT.forEach((turn, i) => {
    const g = guaranteed[i];
    const o = onDemand[i];
    const gT = med(g.ttft);
    const oT = med(o.ttft);
    const gR = med(g.retr);
    const oR = med(o.retr);
    const delta = gT != null && oT != null ? oT - gT : null;
    const sign = delta == null ? '' : delta < 0 ? ` (on-demand ${Math.round(-delta)}ms faster)` : ` (on-demand ${Math.round(delta)}ms slower)`;
    console.log(
      `  ${i + 1}  ${turn.kind.padEnd(7)} |   ${fmt(gT)}        ${gR}   |   ${fmt(oT)}       ${oR}   | ${fmt(delta)}${sign}`,
    );
  });
  console.log('\nExpected: ROUTE turns → guaranteed #ret=2 (host turn + flow node, both wasted), on-demand #ret=0 (the win).');
  console.log('          ANSWER turns → guaranteed #ret=1 (pre-inject), on-demand #ret≥1 via tool (extra round-trip).');
}

main().catch((e) => { console.error(e); process.exit(1); });
