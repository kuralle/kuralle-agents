import type { NextConfig } from 'next';
import { resolve } from 'node:path';

const repositoryRoot = resolve(import.meta.dirname, '../../..');

const nextConfig: NextConfig = {
  poweredByHeader: false,
  turbopack: { root: repositoryRoot },
};

export default nextConfig;
