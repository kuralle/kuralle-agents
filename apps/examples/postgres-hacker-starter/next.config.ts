import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  serverExternalPackages: [
    'pg',
    '@earendil-works/pi-agent-core',
    '@earendil-works/pi-ai',
    '@kuralle-agents/pi-driver',
  ],
  transpilePackages: [
    '@kuralle-agents/core',
    '@kuralle-agents/postgres-store',
  ],
};

export default nextConfig;
