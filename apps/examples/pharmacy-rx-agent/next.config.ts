import type { NextConfig } from 'next';
import { resolve } from 'node:path';

const repositoryRoot = resolve(import.meta.dirname, '../../..');

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // The workspace packages and Bun's linked dependency store sit above this app.
  // Turbopack must be allowed to follow those links inside the repository boundary.
  turbopack: {
    root: repositoryRoot,
  },
};

export default nextConfig;
