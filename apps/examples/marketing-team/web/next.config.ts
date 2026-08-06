import type { NextConfig } from 'next';

// The Next app is a pure client — it never imports `server/`, `db/`, or `agent/` directly (that
// would bundle the Bun-only agent runtime, and the Postgres driver, into the Next build; see
// the module comment on `server/index.ts` for why those two run as a separate Bun process).
// Every `/api/*` call the browser makes is proxied straight through to that standalone Hono
// server instead, so the Next build never needs `DATABASE_URL` or `OPENAI_API_KEY` at all.
const BACKEND_URL = (process.env.MARKETING_TEAM_API_URL?.trim() || 'http://localhost:4001').replace(/\/$/, '');

const nextConfig: NextConfig = {
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${BACKEND_URL}/api/:path*` }];
  },
};

export default nextConfig;
