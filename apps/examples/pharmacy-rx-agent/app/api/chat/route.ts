import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEFAULT_UPSTREAM = 'https://kuralle-pharmacy-workspace-agent.mithushancj.workers.dev';

function upstream(): string {
  return (process.env.CLOUDFLARE_AGENT_URL || DEFAULT_UPSTREAM).replace(/\/$/, '');
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as { sessionId?: unknown; message?: unknown } | null;
  if (!body || typeof body.sessionId !== 'string' || typeof body.message !== 'string' || !body.message.trim()) {
    return NextResponse.json({ error: 'sessionId and message are required' }, { status: 400 });
  }

  try {
    const response = await fetch(`${upstream()}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: body.sessionId, message: body.message }),
      signal: AbortSignal.timeout(90_000),
      cache: 'no-store',
    });
    const data = await response.json().catch(() => ({ error: `Upstream returned ${response.status}` }));
    return NextResponse.json(data, {
      status: response.status,
      headers: { 'x-kuralle-host': 'vercel-next-cloudflare-do' },
    });
  } catch (error) {
    console.error(JSON.stringify({ message: 'pharmacy upstream chat failed', error: error instanceof Error ? error.message : String(error) }));
    return NextResponse.json({ error: 'The durable pharmacy agent is temporarily unavailable.' }, { status: 502 });
  }
}
