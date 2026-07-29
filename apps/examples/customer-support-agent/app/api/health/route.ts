import { getSupportRuntime } from '../../../server/runtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  try {
    await getSupportRuntime();
    return Response.json({
      status: 'ok',
      runtime: 'vercel-node-postgres',
      driver: 'pi',
      durability: 'postgres',
    }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    console.error(JSON.stringify({ event: 'support_health_failed', error: error instanceof Error ? error.message : String(error) }));
    return Response.json({ status: 'unavailable' }, { status: 503, headers: { 'cache-control': 'no-store' } });
  }
}
