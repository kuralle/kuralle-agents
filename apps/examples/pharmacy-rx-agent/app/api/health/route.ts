import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEFAULT_UPSTREAM = 'https://kuralle-pharmacy-workspace-agent.mithushancj.workers.dev';

export async function GET() {
  const origin = (process.env.CLOUDFLARE_AGENT_URL || DEFAULT_UPSTREAM).replace(/\/$/, '');
  try {
    const response = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(10_000), cache: 'no-store' });
    const upstream = await response.json();
    return NextResponse.json({ status: response.ok ? 'ok' : 'degraded', host: 'vercel-next', upstream });
  } catch {
    return NextResponse.json({ status: 'degraded', host: 'vercel-next', upstream: 'unreachable' }, { status: 503 });
  }
}
