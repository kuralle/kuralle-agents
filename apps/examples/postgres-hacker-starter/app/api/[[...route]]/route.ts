import { handle } from 'hono/vercel';
import { api } from '@/server/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handle(api);
export const POST = handle(api);
