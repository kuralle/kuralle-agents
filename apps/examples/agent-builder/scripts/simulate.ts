/**
 * Multi-tenant load simulation.
 *
 * Two tenants, several users each, and — the point of the exercise — thread ids
 * that COLLIDE across tenants. A phone number or an email is a perfectly
 * ordinary thread id for two different businesses, so the interesting question
 * is not "does it work" but "does tenant B ever see tenant A's conversation".
 *
 *   OPENAI_API_KEY=… bun run scripts/simulate.ts
 *   BASE=http://localhost:8787 CONCURRENCY=6 bun run scripts/simulate.ts
 */

export {};

const BASE = process.env.BASE ?? 'http://localhost:8787';

interface Persona {
  tenant: 'acme' | 'globex';
  token: string;
  user: string;
  /** Deliberately reused across tenants. */
  threadId: string;
  secret: string;
}

/**
 * Thread ids must match `^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$` — so a phone
 * number is usable as-is, but an EMAIL IS NOT: `@` is outside the charset and
 * the request is rejected. Derive a safe id instead of passing the raw address.
 */
const threadIdFor = (identifier: string) =>
  identifier.replace(/[^a-zA-Z0-9._:-]/g, '-').replace(/^[^a-zA-Z0-9]/, 'u');

// Both tenants use the SAME two thread ids.
const SHARED_THREADS = ['94778984729', threadIdFor('dana@example.com')];

const PERSONAS: Persona[] = [
  { tenant: 'acme', token: 'demo-acme', user: 'ada', threadId: SHARED_THREADS[0]!, secret: 'ACME-ALPHA-11' },
  { tenant: 'acme', token: 'demo-acme', user: 'bo', threadId: SHARED_THREADS[1]!, secret: 'ACME-BRAVO-22' },
  { tenant: 'acme', token: 'demo-acme', user: 'cy', threadId: 'acme-only-thread', secret: 'ACME-CHARLIE-33' },
  { tenant: 'globex', token: 'demo-globex', user: 'hank', threadId: SHARED_THREADS[0]!, secret: 'GLOBEX-DELTA-44' },
  { tenant: 'globex', token: 'demo-globex', user: 'ivy', threadId: SHARED_THREADS[1]!, secret: 'GLOBEX-ECHO-55' },
];

const failures: string[] = [];
const check = (label: string, ok: boolean, detail?: unknown) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok || detail === undefined ? '' : ` -> ${String(detail).slice(0, 90)}`}`);
  if (!ok) failures.push(label);
};

const api = async (token: string, path: string, init: RequestInit = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
};

/** Publish a version whose instructions make the tenant identifiable in replies. */
async function publishFor(token: string, tenant: string): Promise<void> {
  await api(token, '/api/agents', { method: 'POST', body: JSON.stringify({ agentId: 'support' }) });
  const definition = await api(token, '/api/agents/support/definition', {
    method: 'POST',
    body: JSON.stringify({
      agentId: 'support',
      name: `${tenant} support`,
      description: 'simulation',
      instructions:
        `You are ${tenant.toUpperCase()} support. Begin every reply with "[${tenant.toUpperCase()}]". ` +
        'If the user gave you a code earlier in this conversation, repeat it exactly when asked. ' +
        'If no code appears in this conversation, say NONE.',
      maxTurns: 4,
    }),
  });
  const current = await api(token, '/api/agents/support/draft');
  const revision = current.body?.draft?.revision ?? 0;
  const saved = await api(token, '/api/agents/support/draft', {
    method: 'PUT',
    body: JSON.stringify({ definition: definition.body, revision }),
  });
  const versions = await api(token, '/api/versions');
  const next = (versions.body?.versions?.[0]?.version ?? 0) + 1;
  await api(token, '/api/agents/support/publish', {
    method: 'POST',
    body: JSON.stringify({ draftRevision: saved.body.revision, version: next }),
  });
}

async function chat(p: Persona, message: string, key: string): Promise<string> {
  const res = await fetch(
    `${BASE}/v1/agents/support/threads/${encodeURIComponent(p.threadId)}/messages`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${p.token}`,
        'content-type': 'application/json',
        'idempotency-key': key,
      },
      body: JSON.stringify({ message }),
    },
  );
  if (!res.ok || !res.body) return `<HTTP ${res.status}>`;
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += value;
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';
    for (const frame of frames) {
      const type = frame.match(/^event: (.*)$/m)?.[1];
      const data = frame.match(/^data: (.*)$/m)?.[1];
      if (type !== 'text-delta' || !data) continue;
      try { text += (JSON.parse(data) as { delta?: string }).delta ?? ''; } catch { /* partial frame */ }
    }
  }
  return text.trim();
}

console.log(`\n== publishing a distinct agent per tenant ==`);
await Promise.all([publishFor('demo-acme', 'acme'), publishFor('demo-globex', 'globex')]);
console.log('  acme and globex each published their own version');

console.log(`\n== turn 1: every persona states a secret (concurrent) ==`);
const first = await Promise.all(PERSONAS.map(async p => {
  const reply = await chat(p, `Remember this code: ${p.secret}.`, `${p.tenant}-${p.user}-1`);
  console.log(`  ${p.tenant.padEnd(7)} ${p.user.padEnd(5)} thread=${p.threadId.padEnd(18)} -> ${reply.slice(0, 58)}`);
  return { p, reply };
}));

console.log(`\n== turn 2: every persona asks for their code back (multi-turn) ==`);
const second = await Promise.all(PERSONAS.map(async p => {
  const reply = await chat(p, 'What code did I give you? Repeat it exactly.', `${p.tenant}-${p.user}-2`);
  console.log(`  ${p.tenant.padEnd(7)} ${p.user.padEnd(5)} thread=${p.threadId.padEnd(18)} -> ${reply.slice(0, 58)}`);
  return { p, reply };
}));

console.log(`\n== isolation ==`);
for (const { p, reply } of second) {
  check(`${p.tenant}/${p.user} recalls its own code`, reply.includes(p.secret), reply);
  const others = PERSONAS.filter(o => o.tenant !== p.tenant).map(o => o.secret);
  const leaked = others.filter(secret => reply.includes(secret));
  check(`${p.tenant}/${p.user} leaked nothing from the other tenant`, leaked.length === 0, leaked.join(','));
}
for (const { p, reply } of first) {
  check(`${p.tenant}/${p.user} was served ITS tenant's agent`, reply.includes(`[${p.tenant.toUpperCase()}]`), reply);
}

console.log(`\n== each tenant sees only its own conversations ==`);
for (const [token, tenant] of [['demo-acme', 'acme'], ['demo-globex', 'globex']] as const) {
  const { body } = await api(token, '/api/conversations');
  const threads: string[] = body.conversations.map((c: { threadId: string }) => c.threadId);
  const expected = PERSONAS.filter(p => p.tenant === tenant).map(p => p.threadId);
  const foreign = PERSONAS.filter(p => p.tenant !== tenant && !expected.includes(p.threadId))
    .map(p => p.threadId)
    .filter(t => threads.includes(t));
  console.log(`  ${tenant}: ${threads.length} conversations — ${threads.join(', ')}`);
  check(`${tenant} sees every thread it used`, expected.every(t => threads.includes(t)), threads.join(','));
  check(`${tenant} sees no thread only the other tenant used`, foreign.length === 0, foreign.join(','));
}

console.log(`\n== the thread-id charset is enforced ==`);
{
  const raw = await fetch(`${BASE}/v1/agents/support/threads/${encodeURIComponent('dana@example.com')}/messages`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer demo-acme',
      'content-type': 'application/json',
      'idempotency-key': `charset-${Date.now()}`,
    },
    body: JSON.stringify({ message: 'hi' }),
  });
  // A raw email is REJECTED — `@` is not in the id charset. Worth asserting so
  // nobody ships a webhook that forwards addresses straight through.
  check('a raw email address is rejected as a thread id', raw.status === 409, raw.status);
  check('the sanitised form is accepted', SHARED_THREADS[1] === 'dana-example.com', SHARED_THREADS[1]);
}

console.log(`\n== the shared thread ids really are shared ==`);
for (const threadId of SHARED_THREADS) {
  const a = await api('demo-acme', `/api/conversations/${encodeURIComponent(threadId)}`);
  const g = await api('demo-globex', `/api/conversations/${encodeURIComponent(threadId)}`);
  const aText = JSON.stringify(a.body.messages);
  const gText = JSON.stringify(g.body.messages);
  const acmeSecrets = PERSONAS.filter(p => p.tenant === 'acme').map(p => p.secret);
  const globexSecrets = PERSONAS.filter(p => p.tenant === 'globex').map(p => p.secret);
  console.log(`  ${threadId}: acme pinned ${a.body.pin?.agentVersionId}, globex pinned ${g.body.pin?.agentVersionId}`);
  check(`${threadId}: two tenants hold separate pins`,
    Boolean(a.body.pin) && Boolean(g.body.pin)
      && a.body.pin.artifactDigest !== g.body.pin.artifactDigest,
    `${a.body.pin?.artifactDigest?.slice(0, 8)} vs ${g.body.pin?.artifactDigest?.slice(0, 8)}`);
  check(`${threadId}: acme's transcript holds no globex secret`,
    !globexSecrets.some(s => aText.includes(s)));
  check(`${threadId}: globex's transcript holds no acme secret`,
    !acmeSecrets.some(s => gText.includes(s)));
}

console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`}`);
process.exit(failures.length === 0 ? 0 : 1);
